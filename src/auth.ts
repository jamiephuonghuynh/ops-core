import type { Env } from "./types";

export function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const supplied = auth.slice(7);
  const expected = env.OPS_CORE_API_KEY || "";
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i += 1) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
