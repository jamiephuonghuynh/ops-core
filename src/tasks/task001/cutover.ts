import { getPublishedMappingSet } from "../../db/field-mappings";
import { listActiveBindings } from "../../db/resource-bindings";
import { getTaskRuntimeOwnership } from "../../db/runtime-ownership";
import { getSourceCoverage } from "../../db/source-coverage";
import type { Env } from "../../types";
import { getResource } from "../../db/resources";
import { readNormalizedSheet } from "../../google/sheets";

export async function task001CutoverReadiness(env: Env) {
  const taskId = "task001_smartlink_order";
  const [owner, coverage, mappingSet, bindings, baseline, notificationSet, unknownCommits, unknownClaims, unknownNotifications, pendingNotifications] = await Promise.all([
    getTaskRuntimeOwnership(env, taskId),
    getSourceCoverage(env, taskId, "GAPP_EXPORT"),
    getPublishedMappingSet(env, taskId),
    listActiveBindings(env, taskId),
    env.DB.prepare(`SELECT meta_value FROM system_meta WHERE meta_key='task001_business_key_bootstrap_v1' LIMIT 1`).first<{meta_value:string}>(),
    env.DB.prepare(`SELECT notification_config_set_id, config_version FROM notification_config_sets WHERE producer_domain='OPS' AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1`).first<{notification_config_set_id:string;config_version:string}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM output_commits oc JOIN execution_instances e ON e.execution_id=oc.execution_id WHERE e.task_id=?1 AND oc.status='UNKNOWN'`).bind(taskId).first<{n:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM business_key_claims WHERE status='UNKNOWN' AND (namespace LIKE 'GAPP_ORDER:%' OR namespace LIKE 'SMARTLINK_ORDER_DELIVERY:%')`).first<{n:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notification_attempts na JOIN notification_events ne ON ne.notification_event_id=na.notification_event_id WHERE ne.task_id=?1 AND na.status='UNKNOWN'`).bind(taskId).first<{n:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM notification_events WHERE task_id=?1 AND status IN ('PENDING','PROCESSING','FAILED','UNKNOWN','PARTIAL')`).bind(taskId).first<{n:number}>(),
  ]);
  const requiredRoles = ["GAPP_EXPORT","VENDOR_DATA","SALES_AREA","GAPP_ORDER","SMARTLINK_ORDER_DELIVERY"];
  const roles = new Set(bindings.map((b)=>b.binding_role));
  const missingBindings = requiredRoles.filter((r)=>!roles.has(r));
  let baselineDetail: any = null; try { baselineDetail = baseline?.meta_value ? JSON.parse(baseline.meta_value) : null; } catch { baselineDetail = baseline?.meta_value ?? null; }
  let baselineStillCurrent = false;
  try {
    const baselineResults = Array.isArray(baselineDetail?.results) ? baselineDetail.results : [];
    const checks: boolean[] = [];
    for (const role of ["GAPP_ORDER","SMARTLINK_ORDER_DELIVERY"]) {
      const binding = bindings.find((b)=>b.binding_role===role);
      const prior = baselineResults.find((r:any)=>r.role===role);
      if (!binding || !prior?.snapshotHash || prior.resourceId !== binding.resource_id) { checks.push(false); continue; }
      const resource = await getResource(env,binding.resource_id); let meta:any={}; try { meta=JSON.parse(resource?.metadata_json||"{}"); } catch {}
      if (!resource?.external_id || !meta.sheetName) { checks.push(false); continue; }
      const ds = await readNormalizedSheet(env,resource.external_id,String(meta.sheetName),String(meta.range||"A:ZZZ"),Number(meta.headerRow||1));
      checks.push(ds.snapshotHash === prior.snapshotHash);
    }
    baselineStillCurrent = checks.length === 2 && checks.every(Boolean);
  } catch { baselineStillCurrent = false; }
  const baselineMatchesCurrentConfig = !!baselineDetail && typeof baselineDetail === "object" && (baselineDetail as any).mappingSetId === (mappingSet?.mapping_set_id ?? null);
  const cutoverPrepared = !!coverage && !!mappingSet && missingBindings.length === 0 && !!baseline && baselineMatchesCurrentConfig && baselineStillCurrent && !!notificationSet && Number(unknownCommits?.n ?? 0) === 0 && Number(unknownClaims?.n ?? 0) === 0;
  const productionReady = owner?.runtime_owner === "CLOUDFLARE" && cutoverPrepared;
  const rollbackSafe = Number(unknownCommits?.n ?? 0) === 0 && Number(unknownClaims?.n ?? 0) === 0 && Number(unknownNotifications?.n ?? 0) === 0 && Number(pendingNotifications?.n ?? 0) === 0;
  return {
    taskId,
    cutoverPrepared,
    productionReady,
    rollbackSafe,
    runtimeOwner: owner?.runtime_owner ?? null,
    sourceCoverage: coverage,
    mappingSetId: mappingSet?.mapping_set_id ?? null,
    bindingVersion: bindings[0]?.binding_version ?? null,
    activeBindingCount: bindings.length,
    missingBindings,
    businessKeyBootstrap: baselineDetail,
    baselineMatchesCurrentConfig,
    baselineStillCurrent,
    notificationConfigSetId: notificationSet?.notification_config_set_id ?? null,
    notificationConfigVersion: notificationSet?.config_version ?? null,
    unknownOutputCommitCount: Number(unknownCommits?.n ?? 0),
    unknownBusinessKeyCount: Number(unknownClaims?.n ?? 0),
    unknownNotificationAttemptCount: Number(unknownNotifications?.n ?? 0),
    pendingNotificationEventCount: Number(pendingNotifications?.n ?? 0),
  };
}

export async function assertTask001ProductionReadiness(env: Env, requireOwnership = true): Promise<void> {
  const state = await task001CutoverReadiness(env);
  const ready = requireOwnership ? state.productionReady : state.cutoverPrepared;
  if (!ready) throw new Error(`TASK001_PRODUCTION_NOT_READY:${JSON.stringify({requireOwnership,runtimeOwner:state.runtimeOwner,coverage:!!state.sourceCoverage,mappingSetId:state.mappingSetId,missingBindings:state.missingBindings,businessKeyBootstrap:!!state.businessKeyBootstrap,baselineMatchesCurrentConfig:state.baselineMatchesCurrentConfig,baselineStillCurrent:state.baselineStillCurrent,notificationConfigSetId:state.notificationConfigSetId,unknownOutputCommitCount:state.unknownOutputCommitCount,unknownBusinessKeyCount:state.unknownBusinessKeyCount})}`);
}
