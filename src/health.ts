import { BUILD_VERSION, CODE_BASE, ENVIRONMENT, SCHEMA_VERSION, SERVICE_NAME } from "../config";
import type { Env } from "../types";
import { jsonResponse } from "../response";

export async function handleHealth(env: Env, requestId: string): Promise<Response> {
  try {
    const schemaVersion = await env.DB.prepare(`SELECT meta_value FROM system_meta WHERE meta_key = 'schema_version' LIMIT 1`).first<string>("meta_value");
    const ok = schemaVersion === SCHEMA_VERSION;
    return jsonResponse({
      status: ok ? "ok" : "degraded",
      service: SERVICE_NAME,
      database: "ok",
      schemaVersion: schemaVersion ?? null,
      expectedSchemaVersion: SCHEMA_VERSION,
      buildVersion: BUILD_VERSION,
      codeBase: CODE_BASE,
      environment: ENVIRONMENT,
    }, ok ? 200 : 503, requestId);
  } catch (error) {
    return jsonResponse({
      status: "error",
      service: SERVICE_NAME,
      database: "error",
      schemaVersion: null,
      expectedSchemaVersion: SCHEMA_VERSION,
      buildVersion: BUILD_VERSION,
      codeBase: CODE_BASE,
      environment: ENVIRONMENT,
      error: error instanceof Error ? error.message : String(error),
    }, 503, requestId);
  }
}

export function handleVersion(requestId: string): Response {
  return jsonResponse({
    ok: true,
    service: SERVICE_NAME,
    buildVersion: BUILD_VERSION,
    codeBase: CODE_BASE,
    schemaVersion: SCHEMA_VERSION,
    environment: ENVIRONMENT,
  }, 200, requestId);
}
