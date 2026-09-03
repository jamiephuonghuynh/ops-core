import { bindExistingResource, normalizeArtifactRole, normalizeDirection } from "../artifacts/service";
import { listExecutionArtifacts } from "../db/artifacts";
import { getExecution } from "../db/executions";
import { getResource } from "../db/resources";
import type { Env } from "../types";
import { errorResponse, jsonResponse } from "../response";

export async function handleListExecutionArtifacts(env: Env, executionId: string, requestId: string): Promise<Response> {
  const execution = await getExecution(env, executionId);
  if (!execution) return errorResponse("EXECUTION_NOT_FOUND", "Execution was not found", 404, requestId);
  const artifacts = await listExecutionArtifacts(env, executionId);
  return jsonResponse({ ok: true, executionId, artifacts }, 200, requestId);
}

export async function handleBindExecutionArtifact(request: Request, env: Env, executionId: string, requestId: string): Promise<Response> {
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400, requestId); }
  if (!raw || typeof raw !== "object") return errorResponse("INVALID_REQUEST", "Request body must be an object", 400, requestId);
  const input = raw as Record<string, unknown>;
  const resourceId = typeof input.resourceId === "string" ? input.resourceId.trim() : "";
  const artifactRole = normalizeArtifactRole(typeof input.artifactRole === "string" ? input.artifactRole : null);
  const direction = normalizeDirection(typeof input.direction === "string" ? input.direction : null);
  const stepInstanceId = input.stepInstanceId === undefined || input.stepInstanceId === null ? null : String(input.stepInstanceId).trim();
  if (!resourceId) return errorResponse("INVALID_REQUEST", "resourceId is required", 400, requestId);
  if (!artifactRole) return errorResponse("INVALID_ARTIFACT_ROLE", "artifactRole is invalid", 400, requestId);
  if (!direction) return errorResponse("INVALID_ARTIFACT_DIRECTION", "direction is invalid", 400, requestId);
  const execution = await getExecution(env, executionId);
  if (!execution) return errorResponse("EXECUTION_NOT_FOUND", "Execution was not found", 404, requestId);
  const resource = await getResource(env, resourceId);
  if (!resource) return errorResponse("RESOURCE_NOT_FOUND", "Resource was not found", 404, requestId);
  if (resource.active_status !== "ACTIVE") return errorResponse("RESOURCE_INACTIVE", "Resource is inactive", 409, requestId);
  if (stepInstanceId) {
    const step = await env.DB.prepare(`SELECT step_instance_id FROM execution_steps WHERE step_instance_id = ?1 AND execution_id = ?2 LIMIT 1`).bind(stepInstanceId, executionId).first<string>("step_instance_id");
    if (!step) return errorResponse("STEP_NOT_FOUND", "stepInstanceId does not belong to this execution", 404, requestId);
  }
  try {
    const result = await bindExistingResource(env, executionId, resourceId, artifactRole, direction, stepInstanceId);
    if (!result) return errorResponse("ARTIFACT_BIND_CONFLICT", "Resource could not be bound to execution", 409, requestId);
    return jsonResponse({ ok: true, executionId, resourceId, artifactId: result.artifact.execution_artifact_id, artifactRole, direction, idempotentReplay: result.idempotentReplay }, result.idempotentReplay ? 200 : 201, requestId);
  } catch {
    return errorResponse("ARTIFACT_BIND_CONFLICT", "Resource could not be bound to execution", 409, requestId);
  }
}
