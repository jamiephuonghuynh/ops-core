import type { Env, ExecutionStepRow } from "../types";

export async function listExecutionSteps(env: Env, executionId: string): Promise<ExecutionStepRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM execution_steps WHERE execution_id = ?1 ORDER BY step_order ASC
  `).bind(executionId).all<ExecutionStepRow>();
  return result.results;
}

export async function beginStep(
  env: Env,
  executionId: string,
  stepCode: string,
  stepOrder: number,
  stepType: string,
  inputSummary: unknown,
): Promise<ExecutionStepRow> {
  const now = new Date().toISOString();
  const stepInstanceId = `STP_${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO execution_steps (
      step_instance_id, execution_id, step_code, step_order, step_type, status, attempt_count,
      started_at, input_summary_json, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'RUNNING', 1, ?6, ?7, ?6, ?6)
    ON CONFLICT(execution_id, step_code) DO UPDATE SET
      status = 'RUNNING',
      attempt_count = execution_steps.attempt_count + 1,
      started_at = COALESCE(execution_steps.started_at, excluded.started_at),
      completed_at = NULL,
      input_summary_json = excluded.input_summary_json,
      error_code = NULL,
      error_detail = NULL,
      updated_at = excluded.updated_at
  `).bind(
    stepInstanceId,
    executionId,
    stepCode,
    stepOrder,
    stepType,
    now,
    JSON.stringify(inputSummary ?? {}),
  ).run();

  const row = await env.DB.prepare(`
    SELECT * FROM execution_steps WHERE execution_id = ?1 AND step_code = ?2 LIMIT 1
  `).bind(executionId, stepCode).first<ExecutionStepRow>();
  if (!row) throw new Error(`Step ${stepCode} could not be loaded after start`);
  return row;
}

export async function completeStep(env: Env, stepInstanceId: string, outputSummary: unknown): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE execution_steps
    SET status = 'SUCCESS', completed_at = ?2, output_summary_json = ?3,
        error_code = NULL, error_detail = NULL, updated_at = ?2
    WHERE step_instance_id = ?1
  `).bind(stepInstanceId, now, JSON.stringify(outputSummary ?? {})).run();
}

export async function failStep(env: Env, stepInstanceId: string, errorCode: string, errorDetail: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE execution_steps
    SET status = 'FAILED', completed_at = ?2, error_code = ?3, error_detail = ?4, updated_at = ?2
    WHERE step_instance_id = ?1
  `).bind(stepInstanceId, now, errorCode, errorDetail.slice(0, 4000)).run();
}
