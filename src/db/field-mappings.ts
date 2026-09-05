import type { Env, FieldMappingEntryRow, FieldMappingSetRow } from "../types";

export async function getPublishedMappingSet(env: Env, taskId: string): Promise<FieldMappingSetRow | null> {
  return env.DB.prepare(`
    SELECT * FROM field_mapping_sets
    WHERE task_id = ?1 AND status = 'PUBLISHED'
    ORDER BY published_at DESC LIMIT 1
  `).bind(taskId).first<FieldMappingSetRow>();
}

export async function listMappingEntries(env: Env, mappingSetId: string): Promise<FieldMappingEntryRow[]> {
  const result = await env.DB.prepare(`
    SELECT * FROM field_mapping_entries
    WHERE mapping_set_id = ?1
    ORDER BY binding_role ASC, mapping_direction ASC, ordinal ASC
  `).bind(mappingSetId).all<FieldMappingEntryRow>();
  return result.results;
}
