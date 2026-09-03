CREATE TABLE IF NOT EXISTS output_commits (
  output_commit_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  step_code TEXT,
  artifact_role TEXT NOT NULL,
  commit_key TEXT NOT NULL,
  business_key TEXT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','COMMITTED','UNKNOWN','FAILED')),
  provider_operation TEXT NOT NULL,
  provider_reference TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  FOREIGN KEY (execution_id) REFERENCES execution_instances(execution_id),
  FOREIGN KEY (resource_id) REFERENCES resource_references(resource_id),
  UNIQUE (execution_id, resource_id, artifact_role, commit_key)
);
CREATE INDEX IF NOT EXISTS idx_output_commits_execution_id ON output_commits(execution_id);
CREATE INDEX IF NOT EXISTS idx_output_commits_resource_id ON output_commits(resource_id);
CREATE INDEX IF NOT EXISTS idx_output_commits_status ON output_commits(status);
CREATE INDEX IF NOT EXISTS idx_output_commits_commit_key ON output_commits(commit_key);
INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at)
VALUES ('schema_version', '0003', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
