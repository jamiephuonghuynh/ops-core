import { sha256HexBytes } from "../artifacts/service";
import { getResource } from "../db/resources";
import { readNormalizedSheet } from "../google/sheets";
import type { Env, GoogleCellValue } from "../types";

function text(value: unknown): string { return value == null ? "" : String(value).trim(); }
function upper(value: unknown): string { return text(value).toUpperCase(); }
function rows(headers: GoogleCellValue[], values: GoogleCellValue[][]): Record<string, unknown>[] {
  const names = headers.map(text);
  return values.map((r) => Object.fromEntries(names.map((h, i) => [h, r[i] ?? ""])));
}
function roleAlias(role: string): string { return role === "VENDOR_ORDER" ? "SMARTLINK_ORDER_DELIVERY" : role; }

export async function publishOpsNotificationConfig(env: Env, input: { operationsMasterResourceId: string; publishedBy: string | null }) {
  const master = await getResource(env, input.operationsMasterResourceId);
  if (!master || master.provider !== "GOOGLE" || master.resource_type !== "GOOGLE_SHEET" || !master.external_id) throw new Error("OPERATIONS_MASTER_RESOURCE_INVALID");
  const [templatesDs, recipientsDs] = await Promise.all([
    readNormalizedSheet(env, master.external_id, "NOTI_TEMPLATES", "A:Z", 1),
    readNormalizedSheet(env, master.external_id, "NOTI_RECIPIENTS", "A:Z", 1),
  ]);
  const templateRows = rows(templatesDs.headers, templatesDs.rows).filter((r) => text(r.TaskID) === "task001_smartlink_order" && upper(r.ActiveStatus) === "ACTIVE");
  const recipientRows = rows(recipientsDs.headers, recipientsDs.rows).filter((r) => text(r.TaskID) === "task001_smartlink_order" && upper(r.ActiveStatus) === "ACTIVE");
  const canonical = JSON.stringify({ templates: templateRows, recipients: recipientRows });
  const sourceHash = await sha256HexBytes(new TextEncoder().encode(canonical).buffer as ArrayBuffer);
  const now = new Date().toISOString();
  const version = `NTF_${now.replace(/[-:.TZ]/g, "").slice(0,17)}_${sourceHash.slice(0,8)}_${crypto.randomUUID().slice(0,6)}`;
  const setId = `NCFG_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO notification_config_sets (notification_config_set_id, producer_domain, config_version, source_resource_id, source_hash, status, published_at, published_by, created_at, updated_at) VALUES (?1,'OPS',?2,?3,?4,'DRAFT',NULL,?5,?6,?6)`).bind(setId, version, input.operationsMasterResourceId, sourceHash, input.publishedBy, now).run();
  const rules = templateRows.map((r) => ({
    id: `NRULE_${crypto.randomUUID()}`,
    sourceTemplateId: text(r.TemplateID),
    outcome: upper(r.Result) || null,
    resourceRole: roleAlias(upper(r.OutputRole)) || null,
    channel: upper(r.Channel) || "EMAIL",
    subject: text(r.SubjectTemplate),
    plain: text(r.BodyTemplatePlain),
    html: text(r.BodyTemplateHTML),
  })).filter((r) => r.channel && r.sourceTemplateId);
  if (rules.length) await env.DB.batch(rules.map((r) => env.DB.prepare(`INSERT INTO notification_rules (notification_rule_id, notification_config_set_id, source_template_id, producer, event_type, task_id, outcome, resource_role, channel, subject_template, body_template_plain, body_template_html, active_flag, created_at) VALUES (?1,?2,?3,'OPS','DELIVERY_COMMITTED','task001_smartlink_order',?4,?5,?6,?7,?8,?9,1,?10)`).bind(r.id,setId,r.sourceTemplateId,r.outcome,r.resourceRole,r.channel,r.subject,r.plain,r.html,now)));
  const recipients = recipientRows.map((r) => ({
    id: `NREC_${crypto.randomUUID()}`,
    sourceId: text(r.RecipientConfigID),
    outcome: upper(r.Result) || null,
    resourceRole: roleAlias(upper(r.OutputRole)) || null,
    channel: upper(r.Channel) || "EMAIL",
    recipientType: upper(r.RecipientType) || "TO",
    value: text(r.Recipient),
  })).filter((r) => r.sourceId && r.value);
  if (recipients.length) await env.DB.batch(recipients.map((r) => env.DB.prepare(`INSERT INTO notification_recipients (notification_recipient_id, notification_config_set_id, source_recipient_config_id, task_id, outcome, resource_role, channel, recipient_type, recipient_value, active_flag, created_at) VALUES (?1,?2,?3,'task001_smartlink_order',?4,?5,?6,?7,?8,1,?9)`).bind(r.id,setId,r.sourceId,r.outcome,r.resourceRole,r.channel,r.recipientType,r.value,now)));
  await env.DB.batch([
    env.DB.prepare(`UPDATE notification_config_sets SET status='SUPERSEDED', updated_at=?2 WHERE producer_domain='OPS' AND status='PUBLISHED' AND notification_config_set_id<>?1`).bind(setId,now),
    env.DB.prepare(`UPDATE notification_config_sets SET status='PUBLISHED', published_at=?2, updated_at=?2 WHERE notification_config_set_id=?1`).bind(setId,now),
  ]);
  return { ok: true as const, notificationConfigSetId: setId, configVersion: version, sourceHash, ruleCount: rules.length, recipientCount: recipients.length };
}
