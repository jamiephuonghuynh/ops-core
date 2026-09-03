export function jsonResponse(data: unknown, status = 200, requestId?: string): Response {
  const body = requestId && data && typeof data === "object" && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), requestId }
    : data;
  return Response.json(body, { status });
}

export function errorResponse(error: string, message: string, status: number, requestId: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ ok: false, error, message, ...(extra ?? {}) }, status, requestId);
}
