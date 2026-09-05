ALTER TABLE execution_instances ADD COLUMN notification_config_set_id TEXT;
ALTER TABLE execution_instances ADD COLUMN run_date TEXT;
ALTER TABLE execution_instances ADD COLUMN run_slot TEXT;
ALTER TABLE execution_instances ADD COLUMN automation_id TEXT;
ALTER TABLE output_commits ADD COLUMN row_count INTEGER;

CREATE TABLE IF NOT EXISTS task_runtime_ownership (
  task_id TEXT PRIMARY KEY,
  runtime_owner TEXT NOT NULL CHECK (runtime_owner IN ('LEGACY_APPS_SCRIPT','CLOUDFLARE')),
  previous_owner TEXT,
  effective_at TEXT,
  changed_by TEXT,
  change_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id)
);

CREATE TABLE IF NOT EXISTS source_coverage_states (
  coverage_state_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_role TEXT NOT NULL,
  coverage_axis TEXT NOT NULL,
  last_contiguous_value TEXT NOT NULL,
  last_coverage_type TEXT,
  last_execution_id TEXT,
  last_input_resource_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, source_role, coverage_axis),
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (last_execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (last_input_resource_id) REFERENCES resource_references(resource_id)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  automation_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  run_slot TEXT NOT NULL,
  automation_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE','ACQUIRED','ACCEPTED','RUNNING','SUCCESS','WARNING','FAILED')),
  execution_id TEXT,
  source_start_date TEXT,
  source_end_date TEXT,
  result_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, run_date, run_slot),
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(task_id, status, run_date DESC);

CREATE TABLE IF NOT EXISTS notification_config_sets (
  notification_config_set_id TEXT PRIMARY KEY,
  producer_domain TEXT NOT NULL,
  config_version TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (producer_domain, config_version),
  FOREIGN KEY (source_resource_id) REFERENCES resource_references(resource_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_config_sets_domain_status ON notification_config_sets(producer_domain, status);

CREATE TABLE IF NOT EXISTS notification_rules (
  notification_rule_id TEXT PRIMARY KEY,
  notification_config_set_id TEXT NOT NULL,
  source_template_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  outcome TEXT,
  resource_role TEXT,
  channel TEXT NOT NULL,
  subject_template TEXT NOT NULL,
  body_template_plain TEXT NOT NULL,
  body_template_html TEXT NOT NULL,
  active_flag INTEGER NOT NULL CHECK (active_flag IN (0,1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_config_set_id) REFERENCES notification_config_sets(notification_config_set_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_match ON notification_rules(notification_config_set_id, producer, event_type, task_id, outcome, resource_role, channel);

CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_recipient_id TEXT PRIMARY KEY,
  notification_config_set_id TEXT NOT NULL,
  source_recipient_config_id TEXT NOT NULL,
  task_id TEXT,
  outcome TEXT,
  resource_role TEXT,
  channel TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_value TEXT NOT NULL,
  active_flag INTEGER NOT NULL CHECK (active_flag IN (0,1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_config_set_id) REFERENCES notification_config_sets(notification_config_set_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_match ON notification_recipients(notification_config_set_id, task_id, outcome, resource_role, channel);

CREATE TABLE IF NOT EXISTS notification_events (
  notification_event_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  producer TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  outcome TEXT,
  resource_role TEXT,
  task_id TEXT,
  execution_id TEXT,
  work_item_id TEXT,
  ticket_id TEXT,
  stage_id TEXT,
  notification_config_set_id TEXT NOT NULL,
  context_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','SENT','PARTIAL','FAILED','UNKNOWN','SKIPPED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (notification_config_set_id) REFERENCES notification_config_sets(notification_config_set_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_events_execution ON notification_events(execution_id, status);

CREATE TABLE IF NOT EXISTS notification_attempts (
  notification_attempt_id TEXT PRIMARY KEY,
  notification_event_id TEXT NOT NULL,
  notification_rule_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED','UNKNOWN')),
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (notification_event_id) REFERENCES notification_events(notification_event_id),
  FOREIGN KEY (notification_rule_id) REFERENCES notification_rules(notification_rule_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_attempts_event ON notification_attempts(notification_event_id, status);

INSERT OR IGNORE INTO task_runtime_ownership (task_id, runtime_owner, previous_owner, effective_at, changed_by, change_reason, updated_at)
VALUES ('task001_smartlink_order', 'LEGACY_APPS_SCRIPT', NULL, NULL, 'MIGRATION_0006', 'Phase 6 cutover foundation installed; ownership remains legacy until explicit cutover.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE task_definitions
SET definition_version = 'TASK001-PRODUCTION-CUTOVER-01',
    execution_mode = 'CUTOVER_READY',
    config_json = '{"taskType":"TASK001","productionCutoverFoundation":true}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE task_id = 'task001_smartlink_order';

INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0006', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
