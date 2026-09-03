import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { WORKFLOW_RETRY_LIMIT } from "../config";
import type { CoreExecutionWorkflowParams, Env, FoundationTestConfig } from "../types";
import { appendExecutionEvent } from "../db/events";
import { getExecution, transitionExecutionIfNotStatus } from "../db/executions";
import { beginStep, completeStep, failStep } from "../db/steps";
import { getTaskDefinition } from "../db/tasks";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordedStep<T>(
  env: Env,
  step: WorkflowStep,
  executionId: string,
  stepCode: string,
  stepOrder: number,
  inputSummary: unknown,
  callback: (attempt: number) => Promise<T>,
): Promise<T> {
  return step.do(
    stepCode,
    { retries: { limit: WORKFLOW_RETRY_LIMIT, delay: "1 second", backoff: "linear" } },
    async () => {
      const row = await beginStep(env, executionId, stepCode, stepOrder, "COMPUTE", inputSummary);
      await appendExecutionEvent(env, executionId, "STEP_STARTED", { stepCode, attempt: row.attempt_count }, row.step_instance_id);
      try {
        const output = await callback(row.attempt_count);
        await completeStep(env, row.step_instance_id, output);
        await appendExecutionEvent(env, executionId, "STEP_COMPLETED", { stepCode, attempt: row.attempt_count }, row.step_instance_id);
        return output;
      } catch (error) {
        const detail = errorText(error);
        await failStep(env, row.step_instance_id, "STEP_EXECUTION_FAILED", detail);
        await appendExecutionEvent(env, executionId, "STEP_FAILED", { stepCode, attempt: row.attempt_count, error: detail }, row.step_instance_id);
        if (row.attempt_count <= WORKFLOW_RETRY_LIMIT) {
          await appendExecutionEvent(env, executionId, "STEP_RETRYING", { stepCode, attempt: row.attempt_count, nextAttempt: row.attempt_count + 1 }, row.step_instance_id);
        }
        throw error;
      }
    },
  );
}

export class CoreExecutionWorkflow extends WorkflowEntrypoint<Env, CoreExecutionWorkflowParams> {
  async run(event: WorkflowEvent<CoreExecutionWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    const executionId = event.payload.executionId;
    const execution = await getExecution(this.env, executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);

    const task = await getTaskDefinition(this.env, execution.task_id);
    if (!task) throw new Error(`Task ${execution.task_id} not found`);

    const config = JSON.parse(task.config_json || "{}") as FoundationTestConfig;

    try {
      const started = await transitionExecutionIfNotStatus(this.env, executionId, "RUNNING", null, null);
      if (started) await appendExecutionEvent(this.env, executionId, "EXECUTION_STARTED", { taskId: execution.task_id });

      const prepare = await recordedStep(
        this.env,
        step,
        executionId,
        "STEP_01_PREPARE",
        1,
        { taskId: execution.task_id, taskVersion: execution.task_version },
        async () => ({ prepared: true, config }),
      );

      const processed = await recordedStep(
        this.env,
        step,
        executionId,
        "STEP_02_PROCESS",
        2,
        { prepared: prepare.prepared },
        async (attempt) => {
          const failStepCode = config.foundationTest?.failStep ?? null;
          const failAttempts = Math.max(0, Number(config.foundationTest?.failAttempts ?? 0));
          if (failStepCode === "STEP_02_PROCESS" && attempt <= failAttempts) {
            throw new Error(`FOUNDATION_TEST_INTENTIONAL_FAILURE attempt=${attempt}`);
          }
          return { processed: true, processAttempt: attempt };
        },
      );

      const finalized = await recordedStep(
        this.env,
        step,
        executionId,
        "STEP_03_FINALIZE",
        3,
        { processed: processed.processed },
        async (attempt) => ({ finalized: true, finalizeAttempt: attempt }),
      );

      const changed = await transitionExecutionIfNotStatus(this.env, executionId, "SUCCESS", "FOUNDATION_SUCCESS", "Core execution foundation workflow completed");
      if (changed) await appendExecutionEvent(this.env, executionId, "EXECUTION_COMPLETED", { resultCode: "FOUNDATION_SUCCESS" });
      return { executionId, status: "SUCCESS", finalized };
    } catch (error) {
      const detail = errorText(error);
      const changed = await transitionExecutionIfNotStatus(this.env, executionId, "FAILED", "WORKFLOW_FAILED", detail);
      if (changed) await appendExecutionEvent(this.env, executionId, "EXECUTION_FAILED", { error: detail });
      throw error;
    }
  }
}
