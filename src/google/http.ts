import type { Env } from "../types";
import { getGoogleAccessToken } from "./auth";

export interface GoogleHttpResult<T = unknown> {
  response: Response;
  data: T | null;
  text: string;
}

export async function googleFetch<T = unknown>(env: Env, url: string, init: RequestInit = {}): Promise<GoogleHttpResult<T>> {
  const { accessToken } = await getGoogleAccessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let data: T | null = null;
  if (text) {
    try { data = JSON.parse(text) as T; } catch { data = null; }
  }
  return { response, data, text };
}

export function mapGoogleError(status: number, area: "SHEETS_READ" | "SHEETS_APPEND" | "DRIVE_READ" | "AUTH"): { status: number; error: string; message: string } {
  if (status === 401) return { status: 502, error: "GOOGLE_AUTH_FAILED", message: "Google authentication failed" };
  if (status === 403) return { status: 403, error: "GOOGLE_ACCESS_DENIED", message: "Google resource access denied" };
  if (status === 404) return { status: 404, error: "GOOGLE_RESOURCE_NOT_FOUND", message: "Google resource not found" };
  if (status === 429) return { status: 503, error: "GOOGLE_RATE_LIMITED", message: "Google API rate limit reached" };
  if (area === "SHEETS_APPEND") return { status: 502, error: "GOOGLE_SHEETS_APPEND_FAILED", message: "Google Sheets append failed" };
  if (area === "DRIVE_READ") return { status: 502, error: "GOOGLE_DRIVE_READ_FAILED", message: "Google Drive read failed" };
  if (area === "AUTH") return { status: 502, error: "GOOGLE_AUTH_FAILED", message: "Google authentication failed" };
  return { status: 502, error: "GOOGLE_SHEETS_READ_FAILED", message: "Google Sheets read failed" };
}
