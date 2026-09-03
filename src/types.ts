export interface Env {
  DB: D1Database;
  EXECUTION_QUEUE: Queue<ExecutionQueueMessage>;
  CORE_EXECUTION_WORKFLOW: Workflow<CoreExecutionWorkflowParams>;
  OPS_CORE_API_KEY: string;
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
