import type { CreateExecutionInput, Env, ExecutionRow, ExecutionStatus, TaskDefinitionRow } from "../types";

export async function getExecution(env: Env, executionId: string): Promise<ExecutionRow | null> {
  return env.DB.prepare(`SELECT * FROM execution_instances WHERE execution_id = ?1 LIMIT 1`).bind(executionId).first<ExecutionRow>();
}

export async function findExecutionByIdempotency(env: Env, taskId: string, idempotencyKey: string): Promise<ExecutionRow | null> {
  return env.DB.prepare(`
    SELECT * FROM execution_instances WHERE task_id = ?1 AND idempotency_key = ?2 LIMIT 1
  `).bind(taskId, idempotencyKey).first<ExecutionRow>();
}

export async function insertExecutionIfAbsent(
  env: Env,
  executionId: string,
  task: TaskDefinitionRow,
  input: CreateExecutionInput,
  requestHash: string,
): Promise<{ execution: ExecutionRow; created: boolean }> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO execution_instances (
      execution_id, task_id, task_version, source_type, source_reference,
      requested_by_actor_type, requested_by_actor_id, requested_at,
      status, idempotency_key, request_hash, parent_execution_id, correlation_id,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'CREATED', ?9, ?10, ?11, ?12, ?13, ?14)
  `).bind(
    executionId,
    task.task_id,
    task.definition_version,
    input.source.type,
    input.source.reference ?? null,
    input.requestedBy?.type ?? "SERVICE",
    input.requestedBy?.id ?? null,
    now,
    input.idempotencyKey,
    requestHash,
    input.parentExecutionId ?? null,
    input.correlationId ?? null,
    now,
    now,
  ).run();

  const existing = await findExecutionByIdempotency(env, task.task_id, input.idempotencyKey);
  if (!existing) throw new Error("Execution insert could not be verified");
  return { execution: existing, created: existing.execution_id === executionId };
}

export async function markExecutionAcceptedIfCreated(env: Env, executionId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE execution_instances
    SET status = 'ACCEPTED', updated_at = ?2
    WHERE execution_id = ?1 AND status = 'CREATED'
  `).bind(executionId, now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function transitionExecutionIfNotStatus(
  env: Env,
  executionId: string,
  status: ExecutionStatus,
  resultCode: string | null,
  resultMessage: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const startedAt = status === "RUNNING" ? now : null;
  const completedAt = ["SUCCESS", "WARNING", "FAILED", "CANCELLED"].includes(status) ? now : null;
  const result = await env.DB.prepare(`
    UPDATE execution_instances
    SET status = ?2,
        started_at = CASE WHEN ?3 IS NOT NULL AND started_at IS NULL THEN ?3 ELSE started_at END,
        completed_at = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE completed_at END,
        result_code = ?5,
        result_message = ?6,
        updated_at = ?7
    WHERE execution_id = ?1 AND status <> ?2
  `).bind(executionId, status, startedAt, completedAt, resultCode, resultMessage, now).run();
  return (result.meta.changes ?? 0) > 0;
}
