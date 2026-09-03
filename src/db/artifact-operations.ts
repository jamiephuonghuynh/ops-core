import type { ArtifactOperationRow, Env } from "../types";

export async function findArtifactOperation(env: Env, executionId: string, artifactRole: string, operationType: string, idempotencyKey: string): Promise<ArtifactOperationRow | null> {
  return env.DB.prepare(`
    SELECT * FROM artifact_operations
    WHERE execution_id = ?1 AND artifact_role = ?2 AND operation_type = ?3 AND idempotency_key = ?4
    LIMIT 1
  `).bind(executionId, artifactRole, operationType, idempotencyKey).first<ArtifactOperationRow>();
}

export async function insertArtifactOperationIfAbsent(env: Env, row: ArtifactOperationRow): Promise<boolean> {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO artifact_operations (
      artifact_operation_id, execution_id, artifact_role, operation_type, idempotency_key, request_hash,
      status, resource_id, execution_artifact_id, error_code, error_message, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  `).bind(
    row.artifact_operation_id, row.execution_id, row.artifact_role, row.operation_type, row.idempotency_key,
    row.request_hash, row.status, row.resource_id, row.execution_artifact_id, row.error_code, row.error_message,
    row.created_at, row.updated_at,
  ).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function markArtifactOperationSuccess(env: Env, operationId: string, resourceId: string, artifactId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE artifact_operations
    SET status = 'SUCCESS', resource_id = ?2, execution_artifact_id = ?3,
        error_code = NULL, error_message = NULL, updated_at = ?4
    WHERE artifact_operation_id = ?1
  `).bind(operationId, resourceId, artifactId, new Date().toISOString()).run();
}

export async function markArtifactOperationFailed(env: Env, operationId: string, errorCode: string, errorMessage: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE artifact_operations
    SET status = 'FAILED', error_code = ?2, error_message = ?3, updated_at = ?4
    WHERE artifact_operation_id = ?1
  `).bind(operationId, errorCode, errorMessage.slice(0, 1000), new Date().toISOString()).run();
}

export async function resetArtifactOperationPending(env: Env, operationId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE artifact_operations
    SET status = 'PENDING', resource_id = NULL, execution_artifact_id = NULL,
        error_code = NULL, error_message = NULL, updated_at = ?2
    WHERE artifact_operation_id = ?1
  `).bind(operationId, new Date().toISOString()).run();
}
