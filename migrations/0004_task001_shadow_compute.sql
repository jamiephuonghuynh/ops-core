ALTER TABLE execution_instances ADD COLUMN request_payload_json TEXT;
INSERT INTO task_definitions (
  task_id, task_name, task_group, definition_version, execution_mode, active_status, config_json, created_at, updated_at
) VALUES (
  'task001_smartlink_order',
  'Smartlink: Dat hang G-APP',
  'FULFILLMENT',
  'TASK001-SHADOW-01',
  'SHADOW_COMPUTE',
  'ACTIVE',
  '{"taskType":"TASK001","shadowCompute":true}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(task_id) DO UPDATE SET
  task_name = excluded.task_name,
  task_group = excluded.task_group,
  definition_version = excluded.definition_version,
  execution_mode = excluded.execution_mode,
  active_status = excluded.active_status,
  config_json = excluded.config_json,
  updated_at = excluded.updated_at;
INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0004', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
