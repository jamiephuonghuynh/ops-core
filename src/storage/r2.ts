import type { Env } from "../types";

export async function putArtifactObject(env: Env, key: string, body: ArrayBuffer, contentType: string, sha256: string, fileName: string): Promise<void> {
  const existing = await env.ARTIFACTS.head(key);
  if (existing) throw new Error("RESOURCE_KEY_COLLISION");
  await env.ARTIFACTS.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { sha256, fileName },
  });
}

export async function getArtifactObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.ARTIFACTS.get(key);
}

export async function deleteArtifactObject(env: Env, key: string): Promise<void> {
  await env.ARTIFACTS.delete(key);
}
