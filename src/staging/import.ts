import { uploadR2Artifact } from "../artifacts/service";
import type { Env } from "../types";

export async function materializeStagingObject(env: Env, input: { executionId: string; stagingObjectKey: string; fileName: string; contentType: string; sha256: string; artifactRole: string }) {
  if (!env.OPS_STAGING_URL || !env.OPS_STAGING_FETCH_KEY) throw new Error("STAGING_FETCH_NOT_CONFIGURED");
  const base = env.OPS_STAGING_URL.replace(/\/$/, "");
  const path = input.stagingObjectKey.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${base}/internal/staging/${path}`, { headers: { Authorization: `Bearer ${env.OPS_STAGING_FETCH_KEY}` } });
  if (!response.ok) throw new Error(`STAGING_FETCH_FAILED:${response.status}`);
  const bytes = await response.arrayBuffer();
  const uploaded = await uploadR2Artifact(env,{ executionId:input.executionId,artifactRole:input.artifactRole,direction:"INPUT",fileName:input.fileName,mimeType:input.contentType||"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",idempotencyKey:`STAGING_IMPORT:${input.stagingObjectKey}:${input.sha256}`,suppliedSha256:input.sha256,bytes,requestId:`STAGING_${input.executionId}` });
  if (uploaded.kind === "ERROR") throw new Error(`${uploaded.error}:${uploaded.message}`);
  return uploaded;
}
