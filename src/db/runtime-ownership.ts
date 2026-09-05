import type { Env, RuntimeOwner, TaskRuntimeOwnershipRow } from "../types";

export async function getTaskRuntimeOwnership(env: Env, taskId: string): Promise<TaskRuntimeOwnershipRow | null> {
  return env.DB.prepare(`SELECT * FROM task_runtime_ownership WHERE task_id = ?1 LIMIT 1`).bind(taskId).first<TaskRuntimeOwnershipRow>();
}

export async function setTaskRuntimeOwnership(env: Env, input: { taskId: string; runtimeOwner: RuntimeOwner; changedBy: string | null; reason: string | null }): Promise<TaskRuntimeOwnershipRow> {
  const current = await getTaskRuntimeOwnership(env, input.taskId);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO task_runtime_ownership (task_id, runtime_owner, previous_owner, effective_at, changed_by, change_reason, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4)
    ON CONFLICT(task_id) DO UPDATE SET
      previous_owner = task_runtime_ownership.runtime_owner,
      runtime_owner = excluded.runtime_owner,
      effective_at = excluded.effective_at,
      changed_by = excluded.changed_by,
      change_reason = excluded.change_reason,
      updated_at = excluded.updated_at
  `).bind(input.taskId, input.runtimeOwner, current?.runtime_owner ?? null, now, input.changedBy, input.reason).run();
  return (await getTaskRuntimeOwnership(env, input.taskId))!;
}
