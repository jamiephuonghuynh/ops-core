CREATE TABLE IF NOT EXISTS resource_references (
  resource_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('R2_OBJECT','DRIVE_FILE','GOOGLE_SHEET','XLSX','CSV','JSON','OT2_ATTACHMENT','API_RESOURCE')),
  provider TEXT NOT NULL,
  canonical_uri TEXT NOT NULL UNIQUE,
  business_uri TEXT,
  external_id TEXT,
  external_parent_id TEXT,
  mime_type TEXT,
  file_name TEXT,
  content_hash TEXT,
  byte_size INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  active_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (active_status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_references_type ON resource_references(resource_type);
CREATE INDEX IF NOT EXISTS idx_resource_references_provider ON resource_references(provider);
CREATE INDEX IF NOT EXISTS idx_resource_references_content_hash ON resource_references(content_hash);
CREATE INDEX IF NOT EXISTS idx_resource_references_active_status ON resource_references(active_status);
CREATE TABLE IF NOT EXISTS execution_artifacts (
  execution_artifact_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  artifact_role TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('INPUT','INTERMEDIATE','OUTPUT','DELIVERY','EVIDENCE')),
  step_instance_id TEXT,
  snapshot_at TEXT NOT NULL,
  content_hash TEXT,
  byte_size INTEGER,
  immutable_flag INTEGER NOT NULL DEFAULT 1 CHECK (immutable_flag IN (0,1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (resource_id) REFERENCES resource_references(resource_id),
  FOREIGN KEY (step_instance_id) REFERENCES execution_steps(step_instance_id),
  UNIQUE (execution_id, artifact_role, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_execution_id ON execution_artifacts(execution_id);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_resource_id ON execution_artifacts(resource_id);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_role ON execution_artifacts(artifact_role);
CREATE INDEX IF NOT EXISTS idx_execution_artifacts_direction ON execution_artifacts(direction);
CREATE TABLE IF NOT EXISTS artifact_operations (
  artifact_operation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  artifact_role TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  resource_id TEXT,
  execution_artifact_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (resource_id) REFERENCES resource_references(resource_id),
  FOREIGN KEY (execution_artifact_id) REFERENCES execution_artifacts(execution_artifact_id),
  UNIQUE (execution_id, artifact_role, operation_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_artifact_operations_execution_id ON artifact_operations(execution_id);
CREATE INDEX IF NOT EXISTS idx_artifact_operations_status ON artifact_operations(status);
INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0002', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
