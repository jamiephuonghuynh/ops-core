import type { Env, InputProcessingRow, InputProcessingStatus } from "../types";

export async function getLatestInputProcessing(env: Env, taskId: string, inputRole: string, resourceIdentity: string): Promise<InputProcessingRow | null> {
  return env.DB.prepare(`
    SELECT * FROM input_processing_records
    WHERE task_id = ?1 AND input_role = ?2 AND resource_identity = ?3
    ORDER BY generation DESC LIMIT 1
  `).bind(taskId, inputRole, resourceIdentity).first<InputProcessingRow>();
}


export async function getPendingManualReprocess(env: Env, taskId: string, inputRole: string): Promise<InputProcessingRow | null> {
  return env.DB.prepare(`
    SELECT * FROM input_processing_records
    WHERE task_id = ?1 AND input_role = ?2 AND status = 'AVAILABLE' AND parent_input_processing_id IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).bind(taskId, inputRole).first<InputProcessingRow>();
}

export async function createAvailableInput(env: Env, input: { taskId: string; inputRole: string; resourceId: string; resourceIdentity: string; contentHash?: string | null; detectedAt: string; generation?: number }): Promise<InputProcessingRow> {
  const now = new Date().toISOString();
  const generation = input.generation ?? 1;
  const id = `IPR_${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO input_processing_records (
      input_processing_id, task_id, input_role, resource_id, resource_identity, content_hash,
      generation, status, detected_at, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'AVAILABLE', ?8, ?9, ?9)
  `).bind(id, input.taskId, input.inputRole, input.resourceId, input.resourceIdentity, input.contentHash ?? null, generation, input.detectedAt, now).run();
  return (await env.DB.prepare(`SELECT * FROM input_processing_records WHERE input_processing_id = ?1`).bind(id).first<InputProcessingRow>())!;
}

export async function claimInputForExecution(env: Env, inputProcessingId: string, executionId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE input_processing_records
    SET status = 'PROCESSING', execution_id = ?2, started_at = ?3, processed_at = NULL,
        result_code = NULL, error_code = NULL, error_detail = NULL, updated_at = ?3
    WHERE input_processing_id = ?1 AND status IN ('AVAILABLE','FAILED')
  `).bind(inputProcessingId, executionId, now).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function finalizeInputProcessing(env: Env, inputProcessingId: string, status: Extract<InputProcessingStatus, 'PROCESSED' | 'PROCESSED_NO_OUTPUT'>, resultCode: string, processedBy: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE input_processing_records
    SET status = ?2, processed_at = ?3, processed_by = ?4, result_code = ?5,
        error_code = NULL, error_detail = NULL, updated_at = ?3
    WHERE input_processing_id = ?1
  `).bind(inputProcessingId, status, now, processedBy, resultCode).run();
}

export async function failInputProcessing(env: Env, inputProcessingId: string, errorCode: string, detail: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE input_processing_records
    SET status = 'FAILED', processed_at = ?2, result_code = NULL, error_code = ?3, error_detail = ?4, updated_at = ?2
    WHERE input_processing_id = ?1 AND status = 'PROCESSING'
  `).bind(inputProcessingId, now, errorCode, detail.slice(0, 4000)).run();
}

export async function createReprocessGeneration(env: Env, inputProcessingId: string, requestedBy: string | null, reason: string | null): Promise<InputProcessingRow | null> {
  const current = await env.DB.prepare(`SELECT * FROM input_processing_records WHERE input_processing_id = ?1`).bind(inputProcessingId).first<InputProcessingRow>();
  if (!current) return null;
  if (!['PROCESSED','PROCESSED_NO_OUTPUT','FAILED'].includes(current.status)) throw new Error(`INPUT_REPROCESS_NOT_ALLOWED:${current.status}`);
  const next = await createAvailableInput(env, {
    taskId: current.task_id,
    inputRole: current.input_role,
    resourceId: current.resource_id,
    resourceIdentity: current.resource_identity,
    contentHash: current.content_hash,
    detectedAt: current.detected_at,
    generation: current.generation + 1,
  });
  await env.DB.prepare(`
    UPDATE input_processing_records
    SET parent_input_processing_id = ?2, reprocess_requested_by = ?3, reprocess_reason = ?4, updated_at = ?5
    WHERE input_processing_id = ?1
  `).bind(next.input_processing_id, current.input_processing_id, requestedBy, reason, new Date().toISOString()).run();
  return (await env.DB.prepare(`SELECT * FROM input_processing_records WHERE input_processing_id = ?1`).bind(next.input_processing_id).first<InputProcessingRow>())!;
}
