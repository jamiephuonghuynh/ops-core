import type { Env, NotificationRecipientRow, NotificationRuleRow } from "../types";
import { setExecutionNotificationConfig } from "../db/executions";
import { sendResendEmail } from "./providers/resend";

export interface NotificationEventInput {
  eventKey: string;
  producer: string;
  eventType: string;
  entityType: string;
  entityId: string;
  taskId?: string | null;
  executionId?: string | null;
  outcome?: string | null;
  resourceRole?: string | null;
  context: Record<string, unknown>;
}

function render(template: string, context: Record<string, unknown>): string {
  return String(template || "").replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key) => context[key] == null ? "" : String(context[key]));
}

export async function getPublishedNotificationConfigSetId(env: Env, producerDomain = "OPS"): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT notification_config_set_id FROM notification_config_sets WHERE producer_domain=?1 AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1`).bind(producerDomain).first<{notification_config_set_id:string}>();
  return row?.notification_config_set_id ?? null;
}

async function configSetForInput(env: Env, input: NotificationEventInput): Promise<string | null> {
  if (input.executionId) {
    const execution = await env.DB.prepare(`SELECT notification_config_set_id FROM execution_instances WHERE execution_id=?1 LIMIT 1`).bind(input.executionId).first<{notification_config_set_id:string|null}>();
    if (execution?.notification_config_set_id) return execution.notification_config_set_id;
  }
  return getPublishedNotificationConfigSetId(env, input.producer === "OPS" ? "OPS" : input.producer);
}

export async function prepareNotificationEvent(env: Env, input: NotificationEventInput): Promise<{ status: string; notificationEventId: string | null; idempotentReplay: boolean; reason?: string }> {
  const existing = await env.DB.prepare(`SELECT * FROM notification_events WHERE event_key=?1 LIMIT 1`).bind(input.eventKey).first<any>();
  if (existing) return { status: existing.status, notificationEventId: existing.notification_event_id, idempotentReplay: true };
  const setId = await configSetForInput(env, input);
  if (!setId) return { status: "SKIPPED", notificationEventId: null, idempotentReplay: false, reason: "NOTIFICATION_CONFIG_NOT_PUBLISHED" };
  if (input.executionId) await setExecutionNotificationConfig(env, input.executionId, setId);
  const eventId = `NEVT_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO notification_events (notification_event_id,event_key,producer,event_type,entity_type,entity_id,outcome,resource_role,task_id,execution_id,work_item_id,ticket_id,stage_id,notification_config_set_id,context_json,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,NULL,NULL,?11,?12,'PENDING',?13,?13)`).bind(eventId,input.eventKey,input.producer,input.eventType,input.entityType,input.entityId,input.outcome??null,input.resourceRole??null,input.taskId??null,input.executionId??null,setId,JSON.stringify(input.context),now).run();
  return { status: "PENDING", notificationEventId: eventId, idempotentReplay: false };
}

async function ensureAttempt(env: Env, input: { eventId: string; ruleId: string; recipient: NotificationRecipientRow }): Promise<any> {
  const key = `${input.eventId}:${input.ruleId}:${input.recipient.recipient_value}`;
  let row = await env.DB.prepare(`SELECT * FROM notification_attempts WHERE idempotency_key=?1 LIMIT 1`).bind(key).first<any>();
  if (row) return row;
  const now = new Date().toISOString();
  const id = `NATT_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO notification_attempts (notification_attempt_id,notification_event_id,notification_rule_id,recipient,recipient_type,channel,provider,idempotency_key,status,provider_message_id,attempt_count,error_code,error_message,created_at,updated_at,sent_at) VALUES (?1,?2,?3,?4,?5,'EMAIL','RESEND',?6,'PENDING',NULL,1,NULL,NULL,?7,?7,NULL)`).bind(id,input.eventId,input.ruleId,input.recipient.recipient_value,input.recipient.recipient_type,key,now).run();
  return env.DB.prepare(`SELECT * FROM notification_attempts WHERE notification_attempt_id=?1`).bind(id).first<any>();
}

export async function deliverNotificationEvent(env: Env, notificationEventId: string) {
  const event = await env.DB.prepare(`SELECT * FROM notification_events WHERE notification_event_id=?1 LIMIT 1`).bind(notificationEventId).first<any>();
  if (!event) throw new Error("NOTIFICATION_EVENT_NOT_FOUND");
  if (["SENT","UNKNOWN","SKIPPED"].includes(event.status)) return { status:event.status, notificationEventId, idempotentReplay:true };
  let context: Record<string, unknown> = {};
  try { context = event.context_json ? JSON.parse(event.context_json) : {}; } catch { context = {}; }
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE notification_events SET status='PROCESSING', updated_at=?2 WHERE notification_event_id=?1`).bind(notificationEventId,now).run();
  const rules = await env.DB.prepare(`SELECT * FROM notification_rules WHERE notification_config_set_id=?1 AND active_flag=1 AND producer=?2 AND event_type=?3 AND (task_id IS NULL OR task_id=?4) AND (outcome IS NULL OR outcome=?5) AND (resource_role IS NULL OR resource_role=?6)`).bind(event.notification_config_set_id,event.producer,event.event_type,event.task_id??null,event.outcome??null,event.resource_role??null).all<NotificationRuleRow>();
  let sent = 0, failed = 0, unknown = 0, skipped = 0;
  for (const rule of rules.results ?? []) {
    if (rule.channel !== "EMAIL") { skipped += 1; continue; }
    const rec = await env.DB.prepare(`SELECT * FROM notification_recipients WHERE notification_config_set_id=?1 AND active_flag=1 AND channel=?2 AND (task_id IS NULL OR task_id=?3) AND (outcome IS NULL OR outcome=?4) AND (resource_role IS NULL OR resource_role=?5) ORDER BY recipient_type, recipient_value`).bind(event.notification_config_set_id,rule.channel,event.task_id??null,event.outcome??null,event.resource_role??null).all<NotificationRecipientRow>();
    const recipients = rec.results ?? [];
    const to = [...new Set(recipients.filter((r)=>r.recipient_type==="TO").map((r)=>r.recipient_value))];
    const cc = [...new Set(recipients.filter((r)=>r.recipient_type==="CC").map((r)=>r.recipient_value))];
    if (!to.length) { skipped += 1; continue; }
    const attempts = [];
    for (const recipient of recipients) attempts.push(await ensureAttempt(env,{eventId:notificationEventId,ruleId:rule.notification_rule_id,recipient}));
    if (attempts.length && attempts.every((a)=>a?.status==="SENT")) { sent += attempts.length; continue; }
    if (attempts.some((a)=>a?.status==="UNKNOWN")) { unknown += attempts.filter((a)=>a?.status==="UNKNOWN").length; continue; }
    for (const a of attempts) if (a?.status === "FAILED") await env.DB.prepare(`UPDATE notification_attempts SET status='PENDING', attempt_count=attempt_count+1, updated_at=?2 WHERE notification_attempt_id=?1`).bind(a.notification_attempt_id,new Date().toISOString()).run();
    const providerKey = `${notificationEventId}:${rule.notification_rule_id}`;
    const result = await sendResendEmail(env,{to,cc,subject:render(rule.subject_template,context),text:render(rule.body_template_plain,context),html:render(rule.body_template_html,context),idempotencyKey:providerKey});
    const at = new Date().toISOString();
    if (result.kind === "SENT") {
      sent += attempts.length;
      await env.DB.batch(attempts.map((a)=>env.DB.prepare(`UPDATE notification_attempts SET status='SENT', provider_message_id=?2, error_code=NULL,error_message=NULL,updated_at=?3,sent_at=?3 WHERE notification_attempt_id=?1`).bind(a.notification_attempt_id,result.providerMessageId,at)));
    } else if (result.kind === "UNKNOWN") {
      unknown += attempts.length;
      await env.DB.batch(attempts.map((a)=>env.DB.prepare(`UPDATE notification_attempts SET status='UNKNOWN',error_code=?2,error_message=?3,updated_at=?4 WHERE notification_attempt_id=?1`).bind(a.notification_attempt_id,result.errorCode,result.errorMessage.slice(0,2000),at)));
    } else {
      failed += attempts.length;
      await env.DB.batch(attempts.map((a)=>env.DB.prepare(`UPDATE notification_attempts SET status='FAILED',error_code=?2,error_message=?3,updated_at=?4 WHERE notification_attempt_id=?1`).bind(a.notification_attempt_id,result.errorCode,result.errorMessage.slice(0,2000),at)));
    }
  }
  const status = unknown > 0 ? "UNKNOWN" : failed > 0 && sent > 0 ? "PARTIAL" : failed > 0 ? "FAILED" : sent > 0 ? "SENT" : "SKIPPED";
  await env.DB.prepare(`UPDATE notification_events SET status=?2, updated_at=?3 WHERE notification_event_id=?1`).bind(notificationEventId,status,new Date().toISOString()).run();
  return { status, notificationEventId, sent, failed, unknown, skipped, idempotentReplay:false };
}

export async function emitNotificationEvent(env: Env, input: NotificationEventInput) {
  const prepared = await prepareNotificationEvent(env, input);
  if (!prepared.notificationEventId) return prepared;
  if (["SENT","UNKNOWN","SKIPPED"].includes(prepared.status)) return prepared;
  return deliverNotificationEvent(env, prepared.notificationEventId);
}

export async function processNotificationBacklog(env: Env, input: { taskId?: string | null; limit?: number }) {
  const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
  const rows = input.taskId
    ? await env.DB.prepare(`SELECT notification_event_id FROM notification_events WHERE task_id=?1 AND status IN ('PENDING','FAILED','PARTIAL') ORDER BY created_at LIMIT ?2`).bind(input.taskId,limit).all<{notification_event_id:string}>()
    : await env.DB.prepare(`SELECT notification_event_id FROM notification_events WHERE status IN ('PENDING','FAILED','PARTIAL') ORDER BY created_at LIMIT ?1`).bind(limit).all<{notification_event_id:string}>();
  const results=[];
  for(const row of rows.results??[]) {
    try { results.push(await deliverNotificationEvent(env,row.notification_event_id)); }
    catch(error){ results.push({notificationEventId:row.notification_event_id,status:"FAILED",error:error instanceof Error?error.message:String(error)}); }
  }
  return { processed:results.length, results };
}
