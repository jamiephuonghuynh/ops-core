import { ARTIFACT_UPLOAD_MAX_BYTES } from "../config";
import { uploadR2Artifact, normalizeArtifactRole, normalizeDirection, sanitizeFileName } from "../artifacts/service";
import { getResource } from "../db/resources";
import { getArtifactObject } from "../storage/r2";
import type { Env } from "../types";
import { errorResponse, jsonResponse } from "../response";

export async function handleUploadR2Resource(request: Request, env: Env, requestId: string): Promise<Response> {
  const executionId = request.headers.get("X-OPS-Execution-Id")?.trim() ?? "";
  const artifactRole = normalizeArtifactRole(request.headers.get("X-OPS-Artifact-Role"));
  const direction = normalizeDirection(request.headers.get("X-OPS-Direction"));
  const fileName = sanitizeFileName(request.headers.get("X-OPS-File-Name"));
  const mimeType = (request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const suppliedSha256 = request.headers.get("X-OPS-SHA256")?.trim().toLowerCase() || null;

  if (!executionId) return errorResponse("INVALID_REQUEST", "X-OPS-Execution-Id is required", 400, requestId);
  if (!artifactRole) return errorResponse("INVALID_ARTIFACT_ROLE", "X-OPS-Artifact-Role must be an uppercase-safe role identifier", 400, requestId);
  if (!direction) return errorResponse("INVALID_ARTIFACT_DIRECTION", "X-OPS-Direction must be INPUT, INTERMEDIATE, OUTPUT, DELIVERY or EVIDENCE", 400, requestId);
  if (!idempotencyKey) return errorResponse("INVALID_REQUEST", "Idempotency-Key is required", 400, requestId);
  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > ARTIFACT_UPLOAD_MAX_BYTES) return errorResponse("ARTIFACT_TOO_LARGE", `Artifact exceeds ${ARTIFACT_UPLOAD_MAX_BYTES} byte limit`, 413, requestId);

  const bytes = await request.arrayBuffer();
  const result = await uploadR2Artifact(env, { executionId, artifactRole, direction, fileName, mimeType, idempotencyKey, suppliedSha256, bytes, requestId });
  if (result.kind === "ERROR") return errorResponse(result.error, result.message, result.status, requestId, result.extra);
  return jsonResponse({
    ok: true,
    resourceId: result.resource.resource_id,
    artifactId: result.artifact.execution_artifact_id,
    sha256: result.resource.content_hash,
    byteSize: result.resource.byte_size,
    fileName: result.resource.file_name,
    mimeType: result.resource.mime_type,
    direction: result.artifact.direction,
    artifactRole: result.artifact.artifact_role,
    idempotentReplay: result.idempotentReplay,
  }, result.idempotentReplay ? 200 : 201, requestId);
}

export async function handleGetResource(env: Env, resourceId: string, requestId: string): Promise<Response> {
  const resource = await getResource(env, resourceId);
  if (!resource) return errorResponse("RESOURCE_NOT_FOUND", "Resource was not found", 404, requestId);
  return jsonResponse({ ok: true, resource }, 200, requestId);
}

export async function handleGetResourceContent(env: Env, resourceId: string, requestId: string): Promise<Response> {
  const resource = await getResource(env, resourceId);
  if (!resource) return errorResponse("RESOURCE_NOT_FOUND", "Resource was not found", 404, requestId);
  if (resource.active_status !== "ACTIVE") return errorResponse("RESOURCE_INACTIVE", "Resource is inactive", 409, requestId);
  if (resource.resource_type !== "R2_OBJECT" || resource.provider !== "CLOUDFLARE_R2" || !resource.external_id) {
    return errorResponse("RESOURCE_CONTENT_UNAVAILABLE", "This resource does not expose binary content through the R2 content endpoint", 409, requestId);
  }
  try {
    const object = await getArtifactObject(env, resource.external_id);
    if (!object) return errorResponse("R2_READ_FAILED", "R2 object was not found for this resource", 404, requestId);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", resource.mime_type || headers.get("Content-Type") || "application/octet-stream");
    headers.set("Content-Length", String(resource.byte_size ?? object.size));
    headers.set("X-OPS-Resource-Id", resource.resource_id);
    if (resource.content_hash) headers.set("X-OPS-SHA256", resource.content_hash);
    headers.set("Cache-Control", "private, no-store");
    return new Response(object.body, { status: 200, headers });
  } catch {
    return errorResponse("R2_READ_FAILED", "Artifact content could not be read", 503, requestId);
  }
}
