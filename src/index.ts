export { CoreExecutionWorkflow } from "./workflows/core-execution";

import type { Env, ExecutionQueueMessage } from "./types";
import { isAuthorized } from "./auth";
import { handleCreateExecution, handleGetExecution, handleGetExecutionEvents } from "./api/executions";
import { handleHealth, handleVersion } from "./api/health";
import { handleGetResource, handleGetResourceContent, handleUploadR2Resource } from "./api/resources";
import { handleBindExecutionArtifact, handleListExecutionArtifacts } from "./api/artifacts";
import { consumeExecutionIngress } from "./queue/execution-ingress";
import { errorResponse } from "./response";

function requestId(): string {
  return `REQ_${crypto.randomUUID()}`;
}

function logRequest(requestIdValue: string, request: Request, startedAt: number, status: number, executionId?: string): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "ops-core-dev",
    requestId: requestIdValue,
    executionId: executionId ?? null,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    durationMs: Date.now() - startedAt,
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reqId = requestId();
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        response = await handleHealth(env, reqId);
      } else if (request.method === "GET" && url.pathname === "/api/version") {
        response = handleVersion(reqId);
      } else {
        if (!isAuthorized(request, env)) {
          response = errorResponse("UNAUTHORIZED", "A valid bearer token is required", 401, reqId);
        } else if (request.method === "POST" && url.pathname === "/api/executions") {
          response = await handleCreateExecution(request, env, reqId);
        } else if (request.method === "POST" && url.pathname === "/api/resources/r2") {
          response = await handleUploadR2Resource(request, env, reqId);
        } else {
          const contentMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/content$/);
          const resourceMatch = url.pathname.match(/^\/api\/resources\/([^/]+)$/);
          const artifactMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/artifacts$/);
          const eventMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/events$/);
          const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
          if (request.method === "GET" && contentMatch) {
            response = await handleGetResourceContent(env, decodeURIComponent(contentMatch[1]), reqId);
          } else if (request.method === "GET" && resourceMatch) {
            response = await handleGetResource(env, decodeURIComponent(resourceMatch[1]), reqId);
          } else if (request.method === "GET" && artifactMatch) {
            response = await handleListExecutionArtifacts(env, decodeURIComponent(artifactMatch[1]), reqId);
          } else if (request.method === "POST" && artifactMatch) {
            response = await handleBindExecutionArtifact(request, env, decodeURIComponent(artifactMatch[1]), reqId);
          } else if (request.method === "GET" && eventMatch) {
            response = await handleGetExecutionEvents(env, decodeURIComponent(eventMatch[1]), reqId);
          } else if (request.method === "GET" && executionMatch) {
            response = await handleGetExecution(env, decodeURIComponent(executionMatch[1]), reqId);
          } else {
            response = errorResponse("NOT_FOUND", "Route not found", 404, reqId);
          }
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), service: "ops-core-dev", requestId: reqId, stage: "HTTP", error: error instanceof Error ? error.message : String(error) }));
      response = errorResponse("INTERNAL_ERROR", "Unexpected internal error", 500, reqId);
    }

    logRequest(reqId, request, startedAt, response.status);
    return response;
  },

  async queue(batch: MessageBatch<ExecutionQueueMessage>, env: Env): Promise<void> {
    await consumeExecutionIngress(batch, env);
  },
};
