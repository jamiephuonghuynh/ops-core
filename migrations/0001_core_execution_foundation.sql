CREATE TABLE IF NOT EXISTS system_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_definitions (
  task_id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  task_group TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  active_status TEXT NOT NULL CHECK (active_status IN ('ACTIVE','INACTIVE')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_instances (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_reference TEXT,
  requested_by_actor_type TEXT NOT NULL,
  requested_by_actor_id TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CREATED','ACCEPTED','RUNNING','WAITING','SUCCESS','WARNING','FAILED','CANCELLED')),
  waiting_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  result_code TEXT,
  result_message TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  parent_execution_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (parent_execution_id) REFERENCES execution_instances(execution_id),
  UNIQUE (task_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_execution_instances_task_id ON execution_instances(task_id);
CREATE INDEX IF NOT EXISTS idx_execution_instances_status ON execution_instances(status);
CREATE INDEX IF NOT EXISTS idx_execution_instances_requested_at ON execution_instances(requested_at);
CREATE INDEX IF NOT EXISTS idx_execution_instances_correlation_id ON execution_instances(correlation_id);

CREATE TABLE IF NOT EXISTS execution_steps (
  step_instance_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_code TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCESS','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  input_summary_json TEXT,
  output_summary_json TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  UNIQUE (execution_id, step_code)
);

CREATE INDEX IF NOT EXISTS idx_execution_steps_execution_id ON execution_steps(execution_id);
CREATE INDEX IF NOT EXISTS idx_execution_steps_status ON execution_steps(status);

CREATE TABLE IF NOT EXISTS execution_events (
  event_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_instance_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (step_instance_id) REFERENCES execution_steps(step_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_events_execution_id ON execution_events(execution_id);
CREATE INDEX IF NOT EXISTS idx_execution_events_created_at ON execution_events(created_at);

INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO task_definitions (
  task_id, task_name, task_group, definition_version, execution_mode, active_status, config_json, created_at, updated_at
) VALUES (
  'core_foundation_success',
  'Core Foundation Success',
  'FOUNDATION_TEST',
  '1',
  'COMPUTE',
  'ACTIVE',
  '{"foundationTest":{"failStep":null,"failAttempts":0}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO task_definitions (
  task_id, task_name, task_group, definition_version, execution_mode, active_status, config_json, created_at, updated_at
) VALUES (
  'core_foundation_retry',
  'Core Foundation Retry',
  'FOUNDATION_TEST',
  '1',
  'COMPUTE',
  'ACTIVE',
  '{"foundationTest":{"failStep":"STEP_02_PROCESS","failAttempts":1}}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
