import type { CreateExecutionInput, Env, SourceType } from "../types";
import { appendExecutionEvent, listExecutionEvents } from "../db/events";
import { findExecutionByIdempotency, getExecution, insertExecutionIfAbsent, markExecutionAcceptedIfCreated } from "../db/executions";
import { listExecutionSteps } from "../db/steps";
import { getTaskDefinition } from "../db/tasks";
import { errorResponse, jsonResponse } from "../response";

const SOURCE_TYPES = new Set<SourceType>(["SCHEDULE", "HUMAN_WORK", "DESKTOP_BOT", "API", "WEBHOOK", "MANUAL", "SYSTEM"]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validateCreateInput(input: unknown): CreateExecutionInput | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.taskId !== "string" || !value.taskId.trim()) return null;
  if (typeof value.idempotencyKey !== "string" || !value.idempotencyKey.trim()) return null;
  if (!value.source || typeof value.source !== "object") return null;
  const source = value.source as Record<string, unknown>;
  if (typeof source.type !== "string" || !SOURCE_TYPES.has(source.type as SourceType)) return null;
  if (source.reference !== undefined && typeof source.reference !== "string") return null;
  if (value.correlationId !== undefined && typeof value.correlationId !== "string") return null;
  if (value.parentExecutionId !== undefined && typeof value.parentExecutionId !== "string") return null;
  if (value.requestedBy !== undefined) {
    if (!value.requestedBy || typeof value.requestedBy !== "object") return null;
    const actor = value.requestedBy as Record<string, unknown>;
    if (actor.type !== undefined && !["USER", "SERVICE", "BOT", "SYSTEM"].includes(String(actor.type))) return null;
    if (actor.id !== undefined && typeof actor.id !== "string") return null;
  }
  return value as unknown as CreateExecutionInput;
}

function hashableRequest(input: CreateExecutionInput): unknown {
  return {
    taskId: input.taskId,
    source: input.source,
    requestedBy: input.requestedBy ?? null,
    correlationId: input.correlationId ?? null,
    parentExecutionId: input.parentExecutionId ?? null,
    payload: input.payload ?? null,
  };
}

async function dispatchExecution(env: Env, executionId: string): Promise<void> {
  await env.EXECUTION_QUEUE.send({ executionId });
  const changed = await markExecutionAcceptedIfCreated(env, executionId);
  if (changed) await appendExecutionEvent(env, executionId, "EXECUTION_ACCEPTED", { dispatch: "QUEUE" });
}

export async function handleCreateExecution(request: Request, env: Env, requestId: string): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400, requestId);
  }
  const input = validateCreateInput(raw);
  if (!input) return errorResponse("INVALID_REQUEST", "taskId, source.type and idempotencyKey are required and must be valid", 400, requestId);

  const task = await getTaskDefinition(env, input.taskId);
  if (!task) return errorResponse("TASK_NOT_FOUND", "Task definition was not found", 404, requestId);
  if (task.active_status !== "ACTIVE") return errorResponse("TASK_INACTIVE", "Task definition is inactive", 409, requestId);

  const requestHash = await sha256Hex(stableStringify(hashableRequest(input)));
  const prior = await findExecutionByIdempotency(env, task.task_id, input.idempotencyKey);
  if (prior && prior.request_hash !== requestHash) {
    return errorResponse("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request payload", 409, requestId, { executionId: prior.execution_id });
  }

  if (prior) {
    if (prior.status === "CREATED") {
      try {
        await dispatchExecution(env, prior.execution_id);
        const current = await getExecution(env, prior.execution_id);
        return jsonResponse({ ok: true, executionId: prior.execution_id, status: current?.status ?? "ACCEPTED", idempotentReplay: true }, 202, requestId);
      } catch {
        return errorResponse("QUEUE_DISPATCH_FAILED", "Execution exists but could not be dispatched to the ingress queue", 503, requestId, { executionId: prior.execution_id, idempotentReplay: true });
      }
    }
    return jsonResponse({ ok: true, executionId: prior.execution_id, status: prior.status, idempotentReplay: true }, 200, requestId);
  }

  const executionId = `EXE_${crypto.randomUUID()}`;
  const inserted = await insertExecutionIfAbsent(env, executionId, task, input, requestHash);
  if (!inserted.created) {
    if (inserted.execution.request_hash !== requestHash) {
      return errorResponse("IDEMPOTENCY_CONFLICT", "The idempotency key was concurrently used with a different request payload", 409, requestId, { executionId: inserted.execution.execution_id });
    }
    if (inserted.execution.status === "CREATED") {
      try {
        await dispatchExecution(env, inserted.execution.execution_id);
        const current = await getExecution(env, inserted.execution.execution_id);
        return jsonResponse({ ok: true, executionId: inserted.execution.execution_id, status: current?.status ?? "ACCEPTED", idempotentReplay: true }, 202, requestId);
      } catch {
        return errorResponse("QUEUE_DISPATCH_FAILED", "Execution exists but could not be dispatched to the ingress queue", 503, requestId, { executionId: inserted.execution.execution_id, idempotentReplay: true });
      }
    }
    return jsonResponse({ ok: true, executionId: inserted.execution.execution_id, status: inserted.execution.status, idempotentReplay: true }, 200, requestId);
  }

  await appendExecutionEvent(
    env,
    executionId,
    "EXECUTION_CREATED",
    { requestId, sourceType: input.source.type, sourceReference: input.source.reference ?? null },
    null,
    input.requestedBy?.type ?? "SERVICE",
    input.requestedBy?.id ?? null,
  );

  try {
    await dispatchExecution(env, executionId);
  } catch {
    return errorResponse("QUEUE_DISPATCH_FAILED", "Execution was created but could not be dispatched to the ingress queue; retry the same request safely", 503, requestId, { executionId, idempotentReplay: false });
  }

  return jsonResponse({ ok: true, executionId, status: "ACCEPTED", idempotentReplay: false }, 202, requestId);
}

export async function handleGetExecution(env: Env, executionId: string, requestId: string): Promise<Response> {
  const execution = await getExecution(env, executionId);
  if (!execution) return errorResponse("EXECUTION_NOT_FOUND", "Execution was not found", 404, requestId);
  const steps = await listExecutionSteps(env, executionId);
  return jsonResponse({ ok: true, execution, steps }, 200, requestId);
}

export async function handleGetExecutionEvents(env: Env, executionId: string, requestId: string): Promise<Response> {
  const execution = await getExecution(env, executionId);
  if (!execution) return errorResponse("EXECUTION_NOT_FOUND", "Execution was not found", 404, requestId);
  const events = await listExecutionEvents(env, executionId);
  return jsonResponse({ ok: true, executionId, events }, 200, requestId);
}
