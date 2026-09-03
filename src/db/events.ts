import type { ActorType, Env, ExecutionEventRow } from "../types";

export async function appendExecutionEvent(
  env: Env,
  executionId: string,
  eventType: string,
  payload: unknown = {},
  stepInstanceId: string | null = null,
  actorType: ActorType = "SYSTEM",
  actorId: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO execution_events (
      event_id, execution_id, step_instance_id, event_type, actor_type, actor_id, event_payload_json, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(
    `EVT_${crypto.randomUUID()}`,
    executionId,
    stepInstanceId,
    eventType,
    actorType,
    actorId,
    JSON.stringify(payload ?? {}),
    now,
  ).run();
}

export async function listExecutionEvents(env: Env, executionId: string): Promise<ExecutionEventRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM execution_events WHERE execution_id = ?1 ORDER BY created_at ASC, event_id ASC
  `).bind(executionId).all<ExecutionEventRow>();
  return result.results;
}
