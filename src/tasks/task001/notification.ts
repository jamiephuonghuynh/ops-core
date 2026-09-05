import { getResource } from "../../db/resources";
import { prepareNotificationEvent } from "../../notification/runtime";
import type { Env } from "../../types";

function parsePayload(value: string | null): any { try { return value ? JSON.parse(value) : {}; } catch { return {}; } }

export async function recoverTask001DeliveryNotificationOutbox(env: Env, limit = 20) {
  const rows = await env.DB.prepare(`
    SELECT oc.output_commit_id, oc.execution_id, oc.resource_id, oc.row_count,
           e.request_payload_json
    FROM output_commits oc
    JOIN execution_instances e ON e.execution_id = oc.execution_id
    LEFT JOIN notification_events ne ON ne.event_key = ('TASK001:DELIVERY_COMMIT:' || oc.output_commit_id)
    WHERE e.task_id = 'task001_smartlink_order'
      AND oc.artifact_role = 'TASK001_SMARTLINK_DELIVERY_COMMIT'
      AND oc.status = 'COMMITTED'
      AND COALESCE(oc.row_count,0) > 0
      AND ne.notification_event_id IS NULL
    ORDER BY oc.committed_at, oc.created_at
    LIMIT ?1
  `).bind(Math.max(1,Math.min(100,Number(limit||20)))).all<any>();
  const recovered=[];
  for(const row of rows.results??[]) {
    const payload=parsePayload(row.request_payload_json);
    const automation=payload?.automation||{};
    const resource=await getResource(env,row.resource_id);
    const prepared=await prepareNotificationEvent(env,{
      eventKey:`TASK001:DELIVERY_COMMIT:${row.output_commit_id}`,
      producer:"OPS",
      eventType:"DELIVERY_COMMITTED",
      entityType:"OUTPUT_COMMIT",
      entityId:row.output_commit_id,
      taskId:"task001_smartlink_order",
      executionId:row.execution_id,
      outcome:"SUCCESS",
      resourceRole:"SMARTLINK_ORDER_DELIVERY",
      context:{
        runDate:automation.runDate||"",
        runSlot:automation.runSlot||"",
        sourceStartDate:automation.sourceStartDate||"",
        sourceEndDate:automation.sourceEndDate||"",
        deliveredRows:Number(row.row_count||0),
        appendedRows:Number(row.row_count||0),
        outputLink:resource?.business_uri||"",
        taskName:"Smartlink: Đặt hàng G-APP",
        executionId:row.execution_id,
        outputCommitId:row.output_commit_id,
        recoveredOutbox:true,
      },
    });
    recovered.push({outputCommitId:row.output_commit_id,notificationEventId:prepared.notificationEventId,status:prepared.status});
  }
  return {recoveredCount:recovered.length,recovered};
}
