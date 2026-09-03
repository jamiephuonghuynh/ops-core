import type { ArtifactDirection, Env, ExecutionArtifactRow, ResourceReferenceRow } from "../types";

export async function getArtifact(env: Env, artifactId: string): Promise<ExecutionArtifactRow | null> {
  return env.DB.prepare(`SELECT * FROM execution_artifacts WHERE execution_artifact_id = ?1 LIMIT 1`).bind(artifactId).first<ExecutionArtifactRow>();
}

export async function findArtifactBinding(env: Env, executionId: string, artifactRole: string, resourceId: string): Promise<ExecutionArtifactRow | null> {
  return env.DB.prepare(`
    SELECT * FROM execution_artifacts
    WHERE execution_id = ?1 AND artifact_role = ?2 AND resource_id = ?3
    LIMIT 1
  `).bind(executionId, artifactRole, resourceId).first<ExecutionArtifactRow>();
}

export async function insertArtifact(env: Env, row: ExecutionArtifactRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO execution_artifacts (
      execution_artifact_id, execution_id, resource_id, artifact_role, direction, step_instance_id,
      snapshot_at, content_hash, byte_size, immutable_flag, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  `).bind(
    row.execution_artifact_id, row.execution_id, row.resource_id, row.artifact_role, row.direction,
    row.step_instance_id, row.snapshot_at, row.content_hash, row.byte_size, row.immutable_flag, row.created_at,
  ).run();
}

export async function listExecutionArtifacts(env: Env, executionId: string): Promise<Array<ExecutionArtifactRow & { resource: ResourceReferenceRow }>> {
  const result = await env.DB.prepare(`
    SELECT
      ea.execution_artifact_id, ea.execution_id, ea.resource_id, ea.artifact_role, ea.direction,
      ea.step_instance_id, ea.snapshot_at, ea.content_hash, ea.byte_size, ea.immutable_flag, ea.created_at,
      rr.resource_type AS rr_resource_type, rr.provider AS rr_provider, rr.canonical_uri AS rr_canonical_uri,
      rr.business_uri AS rr_business_uri, rr.external_id AS rr_external_id, rr.external_parent_id AS rr_external_parent_id,
      rr.mime_type AS rr_mime_type, rr.file_name AS rr_file_name, rr.content_hash AS rr_content_hash,
      rr.byte_size AS rr_byte_size, rr.metadata_json AS rr_metadata_json, rr.active_status AS rr_active_status,
      rr.created_at AS rr_created_at, rr.updated_at AS rr_updated_at
    FROM execution_artifacts ea
    JOIN resource_references rr ON rr.resource_id = ea.resource_id
    WHERE ea.execution_id = ?1
    ORDER BY ea.created_at ASC, ea.execution_artifact_id ASC
  `).bind(executionId).all<Record<string, unknown>>();

  return result.results.map((row) => ({
    execution_artifact_id: String(row.execution_artifact_id),
    execution_id: String(row.execution_id),
    resource_id: String(row.resource_id),
    artifact_role: String(row.artifact_role),
    direction: String(row.direction) as ArtifactDirection,
    step_instance_id: row.step_instance_id === null ? null : String(row.step_instance_id),
    snapshot_at: String(row.snapshot_at),
    content_hash: row.content_hash === null ? null : String(row.content_hash),
    byte_size: row.byte_size === null ? null : Number(row.byte_size),
    immutable_flag: Number(row.immutable_flag),
    created_at: String(row.created_at),
    resource: {
      resource_id: String(row.resource_id),
      resource_type: String(row.rr_resource_type) as ResourceReferenceRow["resource_type"],
      provider: String(row.rr_provider),
      canonical_uri: String(row.rr_canonical_uri),
      business_uri: row.rr_business_uri === null ? null : String(row.rr_business_uri),
      external_id: row.rr_external_id === null ? null : String(row.rr_external_id),
      external_parent_id: row.rr_external_parent_id === null ? null : String(row.rr_external_parent_id),
      mime_type: row.rr_mime_type === null ? null : String(row.rr_mime_type),
      file_name: row.rr_file_name === null ? null : String(row.rr_file_name),
      content_hash: row.rr_content_hash === null ? null : String(row.rr_content_hash),
      byte_size: row.rr_byte_size === null ? null : Number(row.rr_byte_size),
      metadata_json: String(row.rr_metadata_json),
      active_status: String(row.rr_active_status) as ResourceReferenceRow["active_status"],
      created_at: String(row.rr_created_at),
      updated_at: String(row.rr_updated_at),
    },
  }));
}

export async function commitUploadedArtifact(env: Env, resource: ResourceReferenceRow, artifact: ExecutionArtifactRow, operationId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO resource_references (
        resource_id, resource_type, provider, canonical_uri, business_uri, external_id, external_parent_id,
        mime_type, file_name, content_hash, byte_size, metadata_json, active_status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    `).bind(
      resource.resource_id, resource.resource_type, resource.provider, resource.canonical_uri, resource.business_uri,
      resource.external_id, resource.external_parent_id, resource.mime_type, resource.file_name, resource.content_hash,
      resource.byte_size, resource.metadata_json, resource.active_status, resource.created_at, resource.updated_at,
    ),
    env.DB.prepare(`
      INSERT INTO execution_artifacts (
        execution_artifact_id, execution_id, resource_id, artifact_role, direction, step_instance_id,
        snapshot_at, content_hash, byte_size, immutable_flag, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(
      artifact.execution_artifact_id, artifact.execution_id, artifact.resource_id, artifact.artifact_role, artifact.direction,
      artifact.step_instance_id, artifact.snapshot_at, artifact.content_hash, artifact.byte_size, artifact.immutable_flag, artifact.created_at,
    ),
    env.DB.prepare(`
      UPDATE artifact_operations
      SET status = 'SUCCESS', resource_id = ?2, execution_artifact_id = ?3,
          error_code = NULL, error_message = NULL, updated_at = ?4
      WHERE artifact_operation_id = ?1
    `).bind(operationId, resource.resource_id, artifact.execution_artifact_id, now),
  ]);
}
