import { GOOGLE_SCOPES, GOOGLE_TOKEN_ENDPOINT } from "../config";
import type { Env } from "../types";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Base64Url(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const body = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function isGoogleWorkspaceConfigured(env: Env): boolean {
  return Boolean(
    typeof env.GOOGLE_SERVICE_ACCOUNT_EMAIL === "string" && env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim() &&
    typeof env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY === "string" && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.trim(),
  );
}

export async function getGoogleAccessToken(env: Env): Promise<{ accessToken: string; expiresIn: number }> {
  if (!isGoogleWorkspaceConfigured(env)) throw new Error("GOOGLE_AUTH_NOT_CONFIGURED");

  const now = Math.floor(Date.now() / 1000);
  const header = utf8Base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = utf8Base64Url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL.trim(),
    scope: GOOGLE_SCOPES.join(" "),
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${base64Url(new Uint8Array(signature))}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GOOGLE_TOKEN_FAILED:${response.status}:${text.slice(0, 300)}`);
  }
  const token = await response.json() as GoogleTokenResponse;
  if (!token.access_token) throw new Error("GOOGLE_TOKEN_FAILED:missing_access_token");
  return { accessToken: token.access_token, expiresIn: Number(token.expires_in || 3600) };
}
