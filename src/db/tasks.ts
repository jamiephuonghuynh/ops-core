import type { Env, TaskDefinitionRow } from "../types";

export async function getTaskDefinition(env: Env, taskId: string): Promise<TaskDefinitionRow | null> {
  return env.DB.prepare(`SELECT * FROM task_definitions WHERE task_id = ?1 LIMIT 1`).bind(taskId).first<TaskDefinitionRow>();
}
