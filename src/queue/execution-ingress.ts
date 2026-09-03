import type { Env, ExecutionQueueMessage } from "../types";
import { appendExecutionEvent } from "../db/events";
import { getExecution, markExecutionAcceptedIfCreated } from "../db/executions";

export async function consumeExecutionIngress(batch: MessageBatch<ExecutionQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const executionId = message.body?.executionId;
    if (!executionId) {
      message.ack();
      continue;
    }

    try {
      const execution = await getExecution(env, executionId);
      if (!execution) {
        message.ack();
        continue;
      }

      if (["RUNNING", "WAITING", "SUCCESS", "WARNING", "FAILED", "CANCELLED"].includes(execution.status)) {
        message.ack();
        continue;
      }

      if (execution.status === "CREATED") {
        const changed = await markExecutionAcceptedIfCreated(env, executionId);
        if (changed) await appendExecutionEvent(env, executionId, "EXECUTION_ACCEPTED", { dispatch: "QUEUE_CONSUMER" });
      }

      try {
        await env.CORE_EXECUTION_WORKFLOW.create({
          id: executionId,
          params: { executionId },
        });
        await appendExecutionEvent(env, executionId, "WORKFLOW_STARTED", { workflowInstanceId: executionId });
      } catch (createError) {
        try {
          const existing = await env.CORE_EXECUTION_WORKFLOW.get(executionId);
          await existing.status();
        } catch {
          throw createError;
        }
      }

      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ service: "ops-core-dev", executionId, stage: "QUEUE_CONSUMER", error: error instanceof Error ? error.message : String(error) }));
      message.retry({ delaySeconds: 5 });
    }
  }
}
