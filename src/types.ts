export interface Env {
  DB: D1Database;
  EXECUTION_QUEUE: Queue<ExecutionQueueMessage>;
  CORE_EXECUTION_WORKFLOW: Workflow<CoreExecutionWorkflowParams>;
  ARTIFACTS: R2Bucket;
  OPS_CORE_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
}

export type ExecutionStatus =
  | "CREATED"
  | "ACCEPTED"
  | "RUNNING"
  | "WAITING"
  | "SUCCESS"
  | "WARNING"
  | "FAILED"
  | "CANCELLED";

export type StepStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
export type ActorType = "USER" | "SERVICE" | "BOT" | "SYSTEM";
export type SourceType = "SCHEDULE" | "HUMAN_WORK" | "DESKTOP_BOT" | "API" | "WEBHOOK" | "MANUAL" | "SYSTEM";
export type ResourceType = "R2_OBJECT" | "DRIVE_FILE" | "GOOGLE_SHEET" | "XLSX" | "CSV" | "JSON" | "OT2_ATTACHMENT" | "API_RESOURCE";
export type ArtifactDirection = "INPUT" | "INTERMEDIATE" | "OUTPUT" | "DELIVERY" | "EVIDENCE";
export type ResourceActiveStatus = "ACTIVE" | "INACTIVE";
export type ArtifactOperationStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface TaskDefinitionRow {
  task_id: string;
  task_name: string;
  task_group: string;
  definition_version: string;
  execution_mode: string;
  active_status: "ACTIVE" | "INACTIVE";
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRow {
  execution_id: string;
  task_id: string;
  task_version: string;
  source_type: SourceType;
  source_reference: string | null;
  requested_by_actor_type: ActorType;
  requested_by_actor_id: string | null;
  requested_at: string;
  status: ExecutionStatus;
  waiting_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_code: string | null;
  result_message: string | null;
  idempotency_key: string;
  request_hash: string;
  request_payload_json: string | null;
  runtime_config_version: string | null;
  mapping_set_id: string | null;
  binding_version: string | null;
  parent_execution_id: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionStepRow {
  step_instance_id: string;
  execution_id: string;
  step_code: string;
  step_order: number;
  step_type: string;
  status: StepStatus;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  input_summary_json: string | null;
  output_summary_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionEventRow {
  event_id: string;
  execution_id: string;
  step_instance_id: string | null;
  event_type: string;
  actor_type: ActorType;
  actor_id: string | null;
  event_payload_json: string;
  created_at: string;
}

export interface ResourceReferenceRow {
  resource_id: string;
  resource_type: ResourceType;
  provider: string;
  canonical_uri: string;
  business_uri: string | null;
  external_id: string | null;
  external_parent_id: string | null;
  mime_type: string | null;
  file_name: string | null;
  content_hash: string | null;
  byte_size: number | null;
  metadata_json: string;
  active_status: ResourceActiveStatus;
  created_at: string;
  updated_at: string;
}

export interface ExecutionArtifactRow {
  execution_artifact_id: string;
  execution_id: string;
  resource_id: string;
  artifact_role: string;
  direction: ArtifactDirection;
  step_instance_id: string | null;
  snapshot_at: string;
  content_hash: string | null;
  byte_size: number | null;
  immutable_flag: number;
  created_at: string;
}

export interface ArtifactOperationRow {
  artifact_operation_id: string;
  execution_id: string;
  artifact_role: string;
  operation_type: string;
  idempotency_key: string;
  request_hash: string;
  status: ArtifactOperationStatus;
  resource_id: string | null;
  execution_artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionSourceInput {
  type: SourceType;
  reference?: string;
}

export interface ExecutionActorInput {
  type?: ActorType;
  id?: string;
}

export interface CreateExecutionInput {
  taskId: string;
  source: ExecutionSourceInput;
  idempotencyKey: string;
  requestedBy?: ExecutionActorInput;
  correlationId?: string;
  parentExecutionId?: string;
  payload?: unknown;
}

export interface ExecutionQueueMessage {
  executionId: string;
}

export interface CoreExecutionWorkflowParams {
  executionId: string;
}

export interface FoundationTestConfig {
  foundationTest?: {
    failStep?: string | null;
    failAttempts?: number;
  };
}


export type GoogleSnapshotMode = "METADATA_ONLY" | "NORMALIZED_SNAPSHOT";
export type OutputCommitStatus = "PREPARED" | "COMMITTED" | "UNKNOWN" | "FAILED";

export interface OutputCommitRow {
  output_commit_id: string;
  execution_id: string;
  resource_id: string;
  step_code: string | null;
  artifact_role: string;
  commit_key: string;
  business_key: string | null;
  payload_hash: string;
  status: OutputCommitStatus;
  provider_operation: string;
  provider_reference: string | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

export type GoogleCellValue = string | number | boolean | null;

export interface NormalizedGoogleSheet {
  headers: GoogleCellValue[];
  rows: GoogleCellValue[][];
  rowCount: number;
  columnCount: number;
  fetchedAt: string;
  snapshotHash: string;
  canonicalJson: string;
}

export type BindingDirection = "INPUT" | "REFERENCE" | "OUTPUT" | "DELIVERY";
export type MappingDirection = "INPUT" | "OUTPUT";
export type InputProcessingStatus = "AVAILABLE" | "PROCESSING" | "PROCESSED" | "PROCESSED_NO_OUTPUT" | "FAILED";
export type BusinessKeyClaimStatus = "CLAIMED" | "COMMITTED" | "UNKNOWN";

export interface ResourceBindingRow {
  binding_id: string;
  task_id: string;
  binding_role: string;
  binding_direction: BindingDirection;
  resource_id: string;
  binding_version: string;
  active_status: "ACTIVE" | "INACTIVE";
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface FieldMappingSetRow {
  mapping_set_id: string;
  task_id: string;
  mapping_version: string;
  source_resource_id: string;
  source_hash: string;
  status: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FieldMappingEntryRow {
  mapping_entry_id: string;
  mapping_set_id: string;
  binding_role: string;
  mapping_direction: MappingDirection;
  source_config_id: string;
  source_field: string;
  standard_field: string;
  data_type: "text" | "number" | "datetime";
  required_flag: number;
  ordinal: number;
  created_at: string;
}

export interface InputProcessingRow {
  input_processing_id: string;
  task_id: string;
  input_role: string;
  resource_id: string;
  resource_identity: string;
  content_hash: string | null;
  generation: number;
  status: InputProcessingStatus;
  execution_id: string | null;
  detected_at: string;
  started_at: string | null;
  processed_at: string | null;
  processed_by: string | null;
  parent_input_processing_id: string | null;
  reprocess_requested_by: string | null;
  reprocess_reason: string | null;
  result_code: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessKeyClaimRow {
  business_key_claim_id: string;
  namespace: string;
  business_key: string;
  payload_hash: string;
  source_execution_id: string;
  canonical_resource_id: string;
  status: BusinessKeyClaimStatus;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}
