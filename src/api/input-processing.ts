import { createReprocessGeneration } from "../db/input-processing";
import type { Env } from "../types";
import { errorResponse, jsonResponse } from "../response";

export async function handleReprocessInput(request: Request, env: Env, inputProcessingId: string, requestId: string): Promise<Response> {
  let body: { requestedBy?: string; reason?: string } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw) as { requestedBy?: string; reason?: string };
  } catch { return errorResponse("INVALID_REQUEST", "Request body must be JSON", 400, requestId); }
  try {
    const row = await createReprocessGeneration(env, inputProcessingId, body.requestedBy?.trim() || null, body.reason?.trim() || null);
    if (!row) return errorResponse("INPUT_PROCESSING_NOT_FOUND", "Input processing record was not found", 404, requestId);
    return jsonResponse({ ok: true, inputProcessing: row }, 201, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("INPUT_REPROCESS_NOT_ALLOWED:")) return errorResponse("INPUT_REPROCESS_NOT_ALLOWED", message, 409, requestId);
    return errorResponse("INPUT_REPROCESS_FAILED", message, 500, requestId);
  }
}
