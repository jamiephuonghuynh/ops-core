ALTER TABLE execution_instances ADD COLUMN runtime_config_version TEXT;
ALTER TABLE execution_instances ADD COLUMN mapping_set_id TEXT;
ALTER TABLE execution_instances ADD COLUMN binding_version TEXT;

CREATE TABLE IF NOT EXISTS resource_bindings (
  binding_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  binding_role TEXT NOT NULL,
  binding_direction TEXT NOT NULL CHECK (binding_direction IN ('INPUT','REFERENCE','OUTPUT','DELIVERY')),
  resource_id TEXT NOT NULL,
  binding_version TEXT NOT NULL,
  active_status TEXT NOT NULL CHECK (active_status IN ('ACTIVE','INACTIVE')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (resource_id) REFERENCES resource_references(resource_id),
  UNIQUE (task_id, binding_role, binding_version)
);
CREATE INDEX IF NOT EXISTS idx_resource_bindings_task_role ON resource_bindings(task_id, binding_role);
CREATE INDEX IF NOT EXISTS idx_resource_bindings_active ON resource_bindings(task_id, active_status);

CREATE TABLE IF NOT EXISTS field_mapping_sets (
  mapping_set_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  source_resource_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (source_resource_id) REFERENCES resource_references(resource_id),
  UNIQUE (task_id, mapping_version)
);
CREATE INDEX IF NOT EXISTS idx_field_mapping_sets_task_status ON field_mapping_sets(task_id, status);

CREATE TABLE IF NOT EXISTS field_mapping_entries (
  mapping_entry_id TEXT PRIMARY KEY,
  mapping_set_id TEXT NOT NULL,
  binding_role TEXT NOT NULL,
  mapping_direction TEXT NOT NULL CHECK (mapping_direction IN ('INPUT','OUTPUT')),
  source_config_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  standard_field TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('text','number','datetime')),
  required_flag INTEGER NOT NULL CHECK (required_flag IN (0,1)),
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mapping_set_id) REFERENCES field_mapping_sets(mapping_set_id),
  UNIQUE (mapping_set_id, binding_role, mapping_direction, source_field)
);
CREATE INDEX IF NOT EXISTS idx_field_mapping_entries_set_role ON field_mapping_entries(mapping_set_id, binding_role, mapping_direction, ordinal);

CREATE TABLE IF NOT EXISTS input_processing_records (
  input_processing_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  input_role TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_identity TEXT NOT NULL,
  content_hash TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE','PROCESSING','PROCESSED','PROCESSED_NO_OUTPUT','FAILED')),
  execution_id TEXT,
  detected_at TEXT NOT NULL,
  started_at TEXT,
  processed_at TEXT,
  processed_by TEXT,
  parent_input_processing_id TEXT,
  reprocess_requested_by TEXT,
  reprocess_reason TEXT,
  result_code TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_definitions(task_id),
  FOREIGN KEY (resource_id) REFERENCES resource_references(resource_id),
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (parent_input_processing_id) REFERENCES input_processing_records(input_processing_id),
  UNIQUE (task_id, input_role, resource_identity, generation)
);
CREATE INDEX IF NOT EXISTS idx_input_processing_lookup ON input_processing_records(task_id, input_role, resource_identity, generation DESC);
CREATE INDEX IF NOT EXISTS idx_input_processing_status ON input_processing_records(task_id, input_role, status);

CREATE TABLE IF NOT EXISTS business_key_claims (
  business_key_claim_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  business_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  canonical_resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CLAIMED','COMMITTED','UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  FOREIGN KEY (source_execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (canonical_resource_id) REFERENCES resource_references(resource_id),
  UNIQUE (namespace, business_key)
);
CREATE INDEX IF NOT EXISTS idx_business_key_claims_execution ON business_key_claims(source_execution_id);
CREATE INDEX IF NOT EXISTS idx_business_key_claims_status ON business_key_claims(namespace, status);

CREATE INDEX IF NOT EXISTS idx_output_commits_resource_business_key ON output_commits(resource_id, business_key);

UPDATE task_definitions
SET definition_version = 'TASK001-PROD-FOUNDATION-01',
    execution_mode = 'SAFE_WRITE_TEST',
    config_json = '{"taskType":"TASK001","safeWriterFoundation":true}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE task_id = 'task001_smartlink_order';

INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0005', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
