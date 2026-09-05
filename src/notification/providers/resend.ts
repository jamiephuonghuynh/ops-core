import type { Env } from "../../types";

export type ProviderSendResult =
  | { kind: "SENT"; providerMessageId: string | null }
  | { kind: "FAILED"; errorCode: string; errorMessage: string }
  | { kind: "UNKNOWN"; errorCode: string; errorMessage: string };

export async function sendResendEmail(env: Env, input: { to: string[]; cc: string[]; subject: string; text: string; html: string; idempotencyKey: string }): Promise<ProviderSendResult> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return { kind: "FAILED", errorCode: "RESEND_NOT_CONFIGURED", errorMessage: "RESEND_API_KEY and RESEND_FROM_EMAIL are required" };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: input.to, cc: input.cc.length ? input.cc : undefined, subject: input.subject, text: input.text || undefined, html: input.html || undefined }),
      signal: controller.signal,
    });
    let body: any = null; try { body = await response.json(); } catch {}
    if (response.ok) return { kind: "SENT", providerMessageId: body?.id ? String(body.id) : null };
    const message = body?.message || body?.error || `HTTP ${response.status}`;
    if ([408,500,502,503,504].includes(response.status)) return { kind: "UNKNOWN", errorCode: `RESEND_HTTP_${response.status}`, errorMessage: message };
    return { kind: "FAILED", errorCode: `RESEND_HTTP_${response.status}`, errorMessage: message };
  } catch (error) {
    return { kind: "UNKNOWN", errorCode: "RESEND_TRANSPORT_UNKNOWN", errorMessage: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}
