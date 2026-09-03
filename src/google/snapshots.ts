import { appendExecutionEvent } from "../db/events";
import { getExecution } from "../db/executions";
import { getResource, updateResourceMetadata } from "../db/resources";
import { uploadR2Artifact } from "../artifacts/service";
import type { Env, GoogleSnapshotMode } from "../types";
import { readNormalizedSheet } from "./sheets";

export async function createGoogleSheetSnapshot(env: Env, input: { executionId: string; resourceId: string; artifactRole: string; snapshotMode: GoogleSnapshotMode; requestId: string }) {
  const execution = await getExecution(env, input.executionId);
  if (!execution) return { kind: "ERROR" as const, status: 404, error: "EXECUTION_NOT_FOUND", message: "Execution was not found" };
  const source = await getResource(env, input.resourceId);
  if (!source) return { kind: "ERROR" as const, status: 404, error: "RESOURCE_NOT_FOUND", message: "Resource was not found" };
  if (source.resource_type !== "GOOGLE_SHEET" || source.provider !== "GOOGLE") return { kind: "ERROR" as const, status: 422, error: "INVALID_RESOURCE_TYPE", message: "Resource is not a Google Sheet" };
  const metadata = JSON.parse(source.metadata_json) as { sheetName: string; range: string; headerRow?: number };
  await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_READ_STARTED", { sourceResourceId: source.resource_id, artifactRole: input.artifactRole });
  const snapshot = await readNormalizedSheet(env, source.external_id || "", metadata.sheetName, metadata.range, metadata.headerRow ?? 1);
  await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_READ_COMPLETED", { sourceResourceId: source.resource_id, artifactRole: input.artifactRole, rowCount: snapshot.rowCount, snapshotHash: snapshot.snapshotHash });

  if (input.snapshotMode === "METADATA_ONLY") {
    const artifactId = `ART_${crypto.randomUUID()}`;
    const now = snapshot.fetchedAt;
    await env.DB.prepare(`
      INSERT INTO execution_artifacts (
        execution_artifact_id, execution_id, resource_id, artifact_role, direction, step_instance_id,
        snapshot_at, content_hash, byte_size, immutable_flag, created_at
      ) VALUES (?1, ?2, ?3, ?4, 'INPUT', NULL, ?5, ?6, NULL, 0, ?5)
    `).bind(artifactId, input.executionId, source.resource_id, input.artifactRole, now, snapshot.snapshotHash).run();
    await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_SNAPSHOT_CREATED", { sourceResourceId: source.resource_id, artifactId, snapshotMode: input.snapshotMode, snapshotHash: snapshot.snapshotHash, rowCount: snapshot.rowCount });
    return { kind: "SUCCESS" as const, sourceResource: source, artifactId, snapshot, snapshotResourceId: null };
  }

  const bytes = new TextEncoder().encode(snapshot.canonicalJson).buffer as ArrayBuffer;
  const uploaded = await uploadR2Artifact(env, {
    executionId: input.executionId,
    artifactRole: input.artifactRole,
    direction: "INPUT",
    fileName: `google-sheet-${source.resource_id}.snapshot.json`,
    mimeType: "application/json",
    idempotencyKey: `GSNAPSHOT:${source.resource_id}:${snapshot.snapshotHash}:${input.artifactRole}`,
    suppliedSha256: snapshot.snapshotHash,
    bytes,
    requestId: input.requestId,
  });
  if (uploaded.kind === "ERROR") return uploaded;
  const meta = JSON.parse(uploaded.resource.metadata_json || "{}") as Record<string, unknown>;
  meta.sourceResourceId = source.resource_id;
  meta.snapshotMode = input.snapshotMode;
  meta.snapshotAt = snapshot.fetchedAt;
  meta.rowCount = snapshot.rowCount;
  meta.columnCount = snapshot.columnCount;
  await updateResourceMetadata(env, uploaded.resource.resource_id, JSON.stringify(meta));
  await appendExecutionEvent(env, input.executionId, "GOOGLE_SHEET_SNAPSHOT_CREATED", { sourceResourceId: source.resource_id, snapshotResourceId: uploaded.resource.resource_id, artifactId: uploaded.artifact.execution_artifact_id, snapshotMode: input.snapshotMode, snapshotHash: snapshot.snapshotHash, rowCount: snapshot.rowCount });
  return { kind: "SUCCESS" as const, sourceResource: source, artifactId: uploaded.artifact.execution_artifact_id, snapshot, snapshotResourceId: uploaded.resource.resource_id, idempotentReplay: uploaded.idempotentReplay };
}
