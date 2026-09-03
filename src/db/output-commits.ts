import type { Env, OutputCommitRow } from "../types";

export async function findOutputCommit(env: Env, executionId: string, resourceId: string, artifactRole: string, commitKey: string): Promise<OutputCommitRow | null> {
  return env.DB.prepare(`
    SELECT * FROM output_commits
    WHERE execution_id = ?1 AND resource_id = ?2 AND artifact_role = ?3 AND commit_key = ?4
    LIMIT 1
  `).bind(executionId, resourceId, artifactRole, commitKey).first<OutputCommitRow>();
}

export async function insertOutputCommitIfAbsent(env: Env, row: OutputCommitRow): Promise<boolean> {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO output_commits (
      output_commit_id, execution_id, resource_id, step_code, artifact_role, commit_key, business_key,
      payload_hash, status, provider_operation, provider_reference, attempt_count, error_code, error_message,
      created_at, updated_at, committed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
  `).bind(
    row.output_commit_id, row.execution_id, row.resource_id, row.step_code, row.artifact_role, row.commit_key,
    row.business_key, row.payload_hash, row.status, row.provider_operation, row.provider_reference,
    row.attempt_count, row.error_code, row.error_message, row.created_at, row.updated_at, row.committed_at,
  ).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function markOutputCommitCommitted(env: Env, commitId: string, providerReference: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE output_commits
    SET status = 'COMMITTED', provider_reference = ?2, attempt_count = attempt_count + 1,
        error_code = NULL, error_message = NULL, committed_at = ?3, updated_at = ?3
    WHERE output_commit_id = ?1
  `).bind(commitId, providerReference, now).run();
}

export async function markOutputCommitUnknown(env: Env, commitId: string, errorCode: string, errorMessage: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE output_commits
    SET status = 'UNKNOWN', attempt_count = attempt_count + 1, error_code = ?2, error_message = ?3, updated_at = ?4
    WHERE output_commit_id = ?1
  `).bind(commitId, errorCode, errorMessage.slice(0, 1000), new Date().toISOString()).run();
}

export async function markOutputCommitFailed(env: Env, commitId: string, errorCode: string, errorMessage: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE output_commits
    SET status = 'FAILED', attempt_count = attempt_count + 1, error_code = ?2, error_message = ?3, updated_at = ?4
    WHERE output_commit_id = ?1
  `).bind(commitId, errorCode, errorMessage.slice(0, 1000), new Date().toISOString()).run();
}
