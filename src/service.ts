import { ARTIFACT_BUCKET_NAME, ARTIFACT_UPLOAD_MAX_BYTES } from "../config";
import { appendExecutionEvent } from "../db/events";
import { getExecution } from "../db/executions";
import { commitUploadedArtifact, findArtifactBinding, insertArtifact } from "../db/artifacts";
import { findArtifactOperation, insertArtifactOperationIfAbsent, markArtifactOperationFailed, resetArtifactOperationPending } from "../db/artifact-operations";
import { getResource } from "../db/resources";
import { deleteArtifactObject, putArtifactObject } from "../storage/r2";
import type { ArtifactDirection, ArtifactOperationRow, Env, ExecutionArtifactRow, ResourceReferenceRow } from "../types";

const DIRECTIONS = new Set<ArtifactDirection>(["INPUT", "INTERMEDIATE", "OUTPUT", "DELIVERY", "EVIDENCE"]);
const ROLE_RE = /^[A-Z0-9][A-Z0-9_\-]{0,99}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function normalizeArtifactRole(value: string | null): string | null {
  const role = (value ?? "").trim().toUpperCase();
  return ROLE_RE.test(role) ? role : null;
}

export function normalizeDirection(value: string | null): ArtifactDirection | null {
  const direction = (value ?? "").trim().toUpperCase() as ArtifactDirection;
  return DIRECTIONS.has(direction) ? direction : null;
}

export function sanitizeFileName(value: string | null): string {
  const raw = (value ?? "artifact.bin").replace(/\\/g, "/").split("/").pop()?.trim() ?? "artifact.bin";
  const safe = raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
  return safe || "artifact.bin";
}

export async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text).buffer as ArrayBuffer);
}

export interface UploadArtifactInput {
  executionId: string;
  artifactRole: string;
  direction: ArtifactDirection;
  fileName: string;
  mimeType: string;
  idempotencyKey: string;
  suppliedSha256: string | null;
  bytes: ArrayBuffer;
  requestId: string;
}

export type UploadArtifactResult =
  | { kind: "SUCCESS"; resource: ResourceReferenceRow; artifact: ExecutionArtifactRow; idempotentReplay: boolean }
  | { kind: "ERROR"; status: number; error: string; message: string; extra?: Record<string, unknown> };

export async function uploadR2Artifact(env: Env, input: UploadArtifactInput): Promise<UploadArtifactResult> {
  const execution = await getExecution(env, input.executionId);
  if (!execution) return { kind: "ERROR", status: 404, error: "EXECUTION_NOT_FOUND", message: "Execution was not found" };
  if (input.bytes.byteLength > ARTIFACT_UPLOAD_MAX_BYTES) return { kind: "ERROR", status: 413, error: "ARTIFACT_TOO_LARGE", message: `Artifact exceeds ${ARTIFACT_UPLOAD_MAX_BYTES} byte limit` };

  const computedHash = await sha256HexBytes(input.bytes);
  if (input.suppliedSha256 && (!SHA256_RE.test(input.suppliedSha256) || input.suppliedSha256 !== computedHash)) {
    await appendExecutionEvent(env, input.executionId, "CONTENT_HASH_MISMATCH", { artifactRole: input.artifactRole, suppliedSha256: input.suppliedSha256, computedSha256: computedHash, requestId: input.requestId });
    return { kind: "ERROR", status: 422, error: "CONTENT_HASH_MISMATCH", message: "Supplied SHA-256 does not match uploaded content", extra: { computedSha256: computedHash } };
  }

  const requestHash = await sha256HexText(JSON.stringify({
    executionId: input.executionId,
    artifactRole: input.artifactRole,
    direction: input.direction,
    fileName: input.fileName,
    mimeType: input.mimeType,
    contentHash: computedHash,
    byteSize: input.bytes.byteLength,
  }));

  let operation = await findArtifactOperation(env, input.executionId, input.artifactRole, "UPLOAD_R2", input.idempotencyKey);
  if (operation && operation.request_hash !== requestHash) {
    return { kind: "ERROR", status: 409, error: "ARTIFACT_IDEMPOTENCY_CONFLICT", message: "The artifact idempotency key was already used with different content or metadata", extra: { resourceId: operation.resource_id, artifactId: operation.execution_artifact_id } };
  }
  if (operation?.status === "SUCCESS" && operation.resource_id && operation.execution_artifact_id) {
    const resource = await getResource(env, operation.resource_id);
    const artifact = await env.DB.prepare(`SELECT * FROM execution_artifacts WHERE execution_artifact_id = ?1 LIMIT 1`).bind(operation.execution_artifact_id).first<ExecutionArtifactRow>();
    if (resource && artifact) {
      await appendExecutionEvent(env, input.executionId, "ARTIFACT_REUSED", { artifactRole: input.artifactRole, resourceId: resource.resource_id, artifactId: artifact.execution_artifact_id, requestId: input.requestId });
      return { kind: "SUCCESS", resource, artifact, idempotentReplay: true };
    }
  }
  if (operation?.status === "PENDING") {
    return { kind: "ERROR", status: 409, error: "ARTIFACT_OPERATION_IN_PROGRESS", message: "An upload with this artifact idempotency key is already in progress" };
  }

  const now = new Date().toISOString();
  if (!operation) {
    const candidate: ArtifactOperationRow = {
      artifact_operation_id: `AOP_${crypto.randomUUID()}`,
      execution_id: input.executionId,
      artifact_role: input.artifactRole,
      operation_type: "UPLOAD_R2",
      idempotency_key: input.idempotencyKey,
      request_hash: requestHash,
      status: "PENDING",
      resource_id: null,
      execution_artifact_id: null,
      error_code: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    const inserted = await insertArtifactOperationIfAbsent(env, candidate);
    operation = inserted ? candidate : await findArtifactOperation(env, input.executionId, input.artifactRole, "UPLOAD_R2", input.idempotencyKey);
    if (!operation) return { kind: "ERROR", status: 500, error: "INTERNAL_ERROR", message: "Artifact operation could not be established" };
    if (operation.request_hash !== requestHash) return { kind: "ERROR", status: 409, error: "ARTIFACT_IDEMPOTENCY_CONFLICT", message: "The artifact idempotency key was concurrently used with different content or metadata" };
    if (!inserted && operation.status === "PENDING") return { kind: "ERROR", status: 409, error: "ARTIFACT_OPERATION_IN_PROGRESS", message: "An upload with this artifact idempotency key is already in progress" };
    if (!inserted && operation.status === "SUCCESS" && operation.resource_id && operation.execution_artifact_id) {
      const resource = await getResource(env, operation.resource_id);
      const artifact = await env.DB.prepare(`SELECT * FROM execution_artifacts WHERE execution_artifact_id = ?1 LIMIT 1`).bind(operation.execution_artifact_id).first<ExecutionArtifactRow>();
      if (resource && artifact) return { kind: "SUCCESS", resource, artifact, idempotentReplay: true };
    }
  } else if (operation.status === "FAILED") {
    await resetArtifactOperationPending(env, operation.artifact_operation_id);
  }

  const resourceId = `RES_${crypto.randomUUID()}`;
  const artifactId = `ART_${crypto.randomUUID()}`;
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const objectKey = `executions/${yyyy}/${mm}/${input.executionId}/${input.direction.toLowerCase()}/${resourceId}/${input.fileName}`;
  const canonicalUri = `r2://${ARTIFACT_BUCKET_NAME}/${objectKey}`;
  const resource: ResourceReferenceRow = {
    resource_id: resourceId,
    resource_type: "R2_OBJECT",
    provider: "CLOUDFLARE_R2",
    canonical_uri: canonicalUri,
    business_uri: null,
    external_id: objectKey,
    external_parent_id: null,
    mime_type: input.mimeType,
    file_name: input.fileName,
    content_hash: computedHash,
    byte_size: input.bytes.byteLength,
    metadata_json: JSON.stringify({ bucket: ARTIFACT_BUCKET_NAME }),
    active_status: "ACTIVE",
    created_at: now,
    updated_at: now,
  };
  const artifact: ExecutionArtifactRow = {
    execution_artifact_id: artifactId,
    execution_id: input.executionId,
    resource_id: resourceId,
    artifact_role: input.artifactRole,
    direction: input.direction,
    step_instance_id: null,
    snapshot_at: now,
    content_hash: computedHash,
    byte_size: input.bytes.byteLength,
    immutable_flag: 1,
    created_at: now,
  };

  await appendExecutionEvent(env, input.executionId, "RESOURCE_UPLOAD_STARTED", { artifactRole: input.artifactRole, direction: input.direction, fileName: input.fileName, byteSize: input.bytes.byteLength, requestId: input.requestId });
  let r2Written = false;
  try {
    await putArtifactObject(env, objectKey, input.bytes, input.mimeType, computedHash, input.fileName);
    r2Written = true;
    await commitUploadedArtifact(env, resource, artifact, operation.artifact_operation_id);
    await appendExecutionEvent(env, input.executionId, "RESOURCE_CREATED", { resourceId, resourceType: "R2_OBJECT", provider: "CLOUDFLARE_R2" });
    await appendExecutionEvent(env, input.executionId, "CONTENT_HASH_VERIFIED", { resourceId, artifactRole: input.artifactRole, sha256: computedHash });
    await appendExecutionEvent(env, input.executionId, "RESOURCE_UPLOAD_COMPLETED", { resourceId, artifactId, objectKey, byteSize: input.bytes.byteLength });
    await appendExecutionEvent(env, input.executionId, "ARTIFACT_BOUND", { resourceId, artifactId, artifactRole: input.artifactRole, direction: input.direction });
    return { kind: "SUCCESS", resource, artifact, idempotentReplay: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (r2Written) {
      try {
        await deleteArtifactObject(env, objectKey);
      } catch (cleanupError) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), service: "ops-core-dev", stage: "R2_ORPHAN_CLEANUP", executionId: input.executionId, objectKey, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }));
      }
    }
    await markArtifactOperationFailed(env, operation.artifact_operation_id, message === "RESOURCE_KEY_COLLISION" ? "RESOURCE_KEY_COLLISION" : "R2_WRITE_FAILED", message);
    await appendExecutionEvent(env, input.executionId, "RESOURCE_UPLOAD_FAILED", { artifactRole: input.artifactRole, direction: input.direction, error: message, requestId: input.requestId });
    return { kind: "ERROR", status: 503, error: message === "RESOURCE_KEY_COLLISION" ? "RESOURCE_KEY_COLLISION" : "R2_WRITE_FAILED", message: "Artifact upload could not be committed" };
  }
}

export async function bindExistingResource(env: Env, executionId: string, resourceId: string, artifactRole: string, direction: ArtifactDirection, stepInstanceId: string | null): Promise<{ resource: ResourceReferenceRow; artifact: ExecutionArtifactRow; idempotentReplay: boolean } | null> {
  const execution = await getExecution(env, executionId);
  if (!execution) return null;
  const resource = await getResource(env, resourceId);
  if (!resource || resource.active_status !== "ACTIVE") return null;
  const existing = await findArtifactBinding(env, executionId, artifactRole, resourceId);
  if (existing) return { resource, artifact: existing, idempotentReplay: true };
  const now = new Date().toISOString();
  const artifact: ExecutionArtifactRow = {
    execution_artifact_id: `ART_${crypto.randomUUID()}`,
    execution_id: executionId,
    resource_id: resourceId,
    artifact_role: artifactRole,
    direction,
    step_instance_id: stepInstanceId,
    snapshot_at: now,
    content_hash: resource.content_hash,
    byte_size: resource.byte_size,
    immutable_flag: 1,
    created_at: now,
  };
  await insertArtifact(env, artifact);
  await appendExecutionEvent(env, executionId, "ARTIFACT_BOUND", { resourceId, artifactId: artifact.execution_artifact_id, artifactRole, direction, reusedResource: true });
  return { resource, artifact, idempotentReplay: false };
}
