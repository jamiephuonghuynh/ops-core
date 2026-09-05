import type { Env, SourceCoverageStateRow } from "../types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(value: string): string { if (!ISO_DATE_RE.test(value)) throw new Error(`SOURCE_COVERAGE_INVALID_DATE:${value}`); return value; }
function addDays(value: string, days: number): string { const d = new Date(`${isoDate(value)}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

export async function getSourceCoverage(env: Env, taskId: string, sourceRole: string, coverageAxis = "CALENDAR_DATE"): Promise<SourceCoverageStateRow | null> {
  return env.DB.prepare(`SELECT * FROM source_coverage_states WHERE task_id = ?1 AND source_role = ?2 AND coverage_axis = ?3 LIMIT 1`).bind(taskId, sourceRole, coverageAxis).first<SourceCoverageStateRow>();
}

export async function initializeSourceCoverage(env: Env, input: { taskId: string; sourceRole: string; lastCoveredDate: string; coverageType?: string; executionId?: string | null; resourceId?: string | null }): Promise<SourceCoverageStateRow> {
  const date = isoDate(input.lastCoveredDate); const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO source_coverage_states (coverage_state_id, task_id, source_role, coverage_axis, last_contiguous_value, last_coverage_type, last_execution_id, last_input_resource_id, updated_at)
    VALUES (?1, ?2, ?3, 'CALENDAR_DATE', ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(task_id, source_role, coverage_axis) DO UPDATE SET
      last_contiguous_value = excluded.last_contiguous_value,
      last_coverage_type = excluded.last_coverage_type,
      last_execution_id = excluded.last_execution_id,
      last_input_resource_id = excluded.last_input_resource_id,
      updated_at = excluded.updated_at
  `).bind(`COV_${crypto.randomUUID()}`, input.taskId, input.sourceRole, date, input.coverageType ?? "BOOTSTRAP", input.executionId ?? null, input.resourceId ?? null, now).run();
  return (await getSourceCoverage(env, input.taskId, input.sourceRole))!;
}

export async function resolveSourcePeriod(env: Env, input: { taskId: string; sourceRole: string; runDate: string }) {
  const targetEndDate = addDays(input.runDate, -1);
  const state = await getSourceCoverage(env, input.taskId, input.sourceRole);
  if (!state) return { status: "BOOTSTRAP_REQUIRED" as const, taskId: input.taskId, runDate: input.runDate, lastCoveredDate: "", targetEndDate, sourceStartDate: "", sourceEndDate: "" };
  if (state.last_contiguous_value >= targetEndDate) return { status: "UP_TO_DATE" as const, taskId: input.taskId, runDate: input.runDate, lastCoveredDate: state.last_contiguous_value, targetEndDate, sourceStartDate: "", sourceEndDate: "" };
  return { status: "READY" as const, taskId: input.taskId, runDate: input.runDate, lastCoveredDate: state.last_contiguous_value, targetEndDate, sourceStartDate: addDays(state.last_contiguous_value, 1), sourceEndDate: targetEndDate };
}

export async function commitSourceCoverage(env: Env, input: { taskId: string; sourceRole: string; sourceStartDate: string; sourceEndDate: string; coverageType: string; executionId?: string | null; resourceId?: string | null }) {
  const state = await getSourceCoverage(env, input.taskId, input.sourceRole);
  if (!state) throw new Error("SOURCE_COVERAGE_BOOTSTRAP_REQUIRED");
  const start = isoDate(input.sourceStartDate); const end = isoDate(input.sourceEndDate);
  if (start > end) throw new Error("SOURCE_COVERAGE_INVALID_PERIOD");
  const expectedStart = addDays(state.last_contiguous_value, 1);
  if (end <= state.last_contiguous_value) return { status: "NO_CHANGE" as const, previousLastCoveredDate: state.last_contiguous_value, lastCoveredDate: state.last_contiguous_value };
  if (start > expectedStart) throw new Error(`SOURCE_COVERAGE_NOT_CONTIGUOUS:${expectedStart}:${start}`);
  const updated = await initializeSourceCoverage(env, { taskId: input.taskId, sourceRole: input.sourceRole, lastCoveredDate: end, coverageType: input.coverageType, executionId: input.executionId ?? null, resourceId: input.resourceId ?? null });
  return { status: "COMMITTED" as const, previousLastCoveredDate: state.last_contiguous_value, lastCoveredDate: updated.last_contiguous_value };
}
