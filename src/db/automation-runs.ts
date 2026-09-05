import type { AutomationRunRow, Env } from "../types";

export async function getAutomationRun(env: Env, taskId: string, runDate: string, runSlot: string): Promise<AutomationRunRow | null> {
  return env.DB.prepare(`SELECT * FROM automation_runs WHERE task_id = ?1 AND run_date = ?2 AND run_slot = ?3 LIMIT 1`).bind(taskId, runDate, runSlot).first<AutomationRunRow>();
}

export async function ensureAutomationRun(env: Env, input: { taskId: string; runDate: string; runSlot: string; automationId?: string | null; requestId?: string | null; sourceStartDate?: string | null; sourceEndDate?: string | null }): Promise<AutomationRunRow> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO automation_runs (automation_run_id, task_id, run_date, run_slot, automation_id, request_id, status, execution_id, source_start_date, source_end_date, result_code, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'AVAILABLE', NULL, ?7, ?8, NULL, ?9, ?9)
  `).bind(`ARUN_${crypto.randomUUID()}`, input.taskId, input.runDate, input.runSlot, input.automationId ?? null, input.requestId ?? null, input.sourceStartDate ?? null, input.sourceEndDate ?? null, now).run();
  return (await getAutomationRun(env, input.taskId, input.runDate, input.runSlot))!;
}

export async function updateAutomationRun(env: Env, taskId: string, runDate: string, runSlot: string, patch: { status: AutomationRunRow["status"]; executionId?: string | null; resultCode?: string | null; automationId?: string | null; requestId?: string | null; sourceStartDate?: string | null; sourceEndDate?: string | null }): Promise<void> {
  await env.DB.prepare(`UPDATE automation_runs SET status = ?4, execution_id = COALESCE(?5, execution_id), result_code = ?6, automation_id = COALESCE(?7, automation_id), request_id = COALESCE(?8, request_id), source_start_date = COALESCE(?9, source_start_date), source_end_date = COALESCE(?10, source_end_date), updated_at = ?11 WHERE task_id = ?1 AND run_date = ?2 AND run_slot = ?3`).bind(taskId, runDate, runSlot, patch.status, patch.executionId ?? null, patch.resultCode ?? null, patch.automationId ?? null, patch.requestId ?? null, patch.sourceStartDate ?? null, patch.sourceEndDate ?? null, new Date().toISOString()).run();
}
