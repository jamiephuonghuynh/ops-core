import { deliverNotificationEvent, emitNotificationEvent, processNotificationBacklog } from "../notification/runtime";
import { errorResponse, jsonResponse } from "../response";
import type { Env } from "../types";

function text(v: unknown): string { return v == null ? "" : String(v).trim(); }
async function jsonBody(request: Request): Promise<any | null> { try { const v = await request.json(); return v && typeof v === "object" ? v : null; } catch { return null; } }

export async function handleEmitNotificationEvent(request: Request, env: Env, requestId: string): Promise<Response> {
  const b = await jsonBody(request);
  if (!b) return errorResponse("INVALID_REQUEST", "JSON body required", 400, requestId);
  const producer = text(b.producer), eventType = text(b.eventType), entityType = text(b.entityType), entityId = text(b.entityId), eventKey = text(b.eventKey);
  if (!producer || !eventType || !entityType || !entityId || !eventKey) return errorResponse("INVALID_REQUEST", "producer, eventType, entityType, entityId and eventKey are required", 400, requestId);
  const context = b.context && typeof b.context === "object" && !Array.isArray(b.context) ? b.context as Record<string, unknown> : {};
  try {
    const result = await emitNotificationEvent(env, { eventKey, producer, eventType, entityType, entityId, taskId:text(b.taskId)||null, executionId:text(b.executionId)||null, outcome:text(b.outcome)||null, resourceRole:text(b.resourceRole)||null, context });
    return jsonResponse({ ok:true, ...result },200,requestId);
  } catch(error){ return errorResponse("NOTIFICATION_EVENT_FAILED",error instanceof Error?error.message:String(error),500,requestId); }
}

export async function handleRetryNotificationEvent(env: Env, notificationEventId: string, requestId: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT status FROM notification_events WHERE notification_event_id=?1 LIMIT 1`).bind(notificationEventId).first<{status:string}>();
  if(!row)return errorResponse("NOTIFICATION_EVENT_NOT_FOUND","Notification event not found",404,requestId);
  if(row.status==="UNKNOWN")return errorResponse("NOTIFICATION_RESULT_UNKNOWN","Notification provider outcome is UNKNOWN; reconcile before retry",409,requestId);
  try{return jsonResponse({ok:true,...await deliverNotificationEvent(env,notificationEventId)},200,requestId);}catch(error){return errorResponse("NOTIFICATION_RETRY_FAILED",error instanceof Error?error.message:String(error),500,requestId);}
}

export async function handleProcessNotificationBacklog(request:Request,env:Env,requestId:string):Promise<Response>{
  const b=await jsonBody(request)??{};
  try{return jsonResponse({ok:true,...await processNotificationBacklog(env,{taskId:text(b.taskId)||null,limit:Number(b.limit||10)})},200,requestId);}catch(error){return errorResponse("NOTIFICATION_BACKLOG_FAILED",error instanceof Error?error.message:String(error),500,requestId);}
}
