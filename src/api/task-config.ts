import { publishTask001ConfigFromOperationsMaster } from "../config-publisher/operations-master";
import type { Env } from "../types";
import { errorResponse, jsonResponse } from "../response";

export async function handlePublishTaskConfig(request: Request, env: Env, requestId: string): Promise<Response> {
  let body: { taskId?: string; operationsMasterResourceId?: string; publishedBy?: string };
  try { body = await request.json(); } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  if (body.taskId !== "task001_smartlink_order") return errorResponse("UNSUPPORTED_TASK_CONFIG", "Phase 5 publisher supports task001_smartlink_order only", 422, requestId);
  if (!body.operationsMasterResourceId?.trim()) return errorResponse("INVALID_REQUEST", "operationsMasterResourceId is required", 400, requestId);
  try {
    const result = await publishTask001ConfigFromOperationsMaster(env, { operationsMasterResourceId: body.operationsMasterResourceId.trim(), publishedBy: body.publishedBy?.trim() || null });
    if (!result.ok) return jsonResponse({ ok: false, error: "CONFIG_VALIDATION_FAILED", errors: result.errors }, 422, requestId);
    return jsonResponse(result, 201, requestId);
  } catch (error) {
    return errorResponse("CONFIG_PUBLISH_FAILED", error instanceof Error ? error.message : String(error), 500, requestId);
  }
}
