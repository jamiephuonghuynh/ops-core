import type { Env, ResourceReferenceRow } from "../types";

export async function getResource(env: Env, resourceId: string): Promise<ResourceReferenceRow | null> {
  return env.DB.prepare(`SELECT * FROM resource_references WHERE resource_id = ?1 LIMIT 1`).bind(resourceId).first<ResourceReferenceRow>();
}

export async function insertResource(env: Env, row: ResourceReferenceRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO resource_references (
      resource_id, resource_type, provider, canonical_uri, business_uri, external_id, external_parent_id,
      mime_type, file_name, content_hash, byte_size, metadata_json, active_status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  `).bind(
    row.resource_id, row.resource_type, row.provider, row.canonical_uri, row.business_uri, row.external_id,
    row.external_parent_id, row.mime_type, row.file_name, row.content_hash, row.byte_size, row.metadata_json,
    row.active_status, row.created_at, row.updated_at,
  ).run();
}
