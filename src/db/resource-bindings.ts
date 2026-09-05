import type { Env, ResourceBindingRow } from "../types";

export async function listActiveBindings(env: Env, taskId: string): Promise<ResourceBindingRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM resource_bindings
    WHERE task_id = ?1 AND active_status = 'ACTIVE'
    ORDER BY binding_role ASC
  `).bind(taskId).all<ResourceBindingRow>();
  return result.results;
}

export async function getActiveBinding(env: Env, taskId: string, role: string): Promise<ResourceBindingRow | null> {
  return env.DB.prepare(`
    SELECT * FROM resource_bindings
    WHERE task_id = ?1 AND binding_role = ?2 AND active_status = 'ACTIVE'
    ORDER BY created_at DESC LIMIT 1
  `).bind(taskId, role).first<ResourceBindingRow>();
}
