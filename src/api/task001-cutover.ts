import { getPublishedMappingSet, listMappingEntries } from "../db/field-mappings";
import { listActiveBindings } from "../db/resource-bindings";
import { getResource } from "../db/resources";
import { getTaskDefinition } from "../db/tasks";
import { readNormalizedSheet } from "../google/sheets";
import { comparablePayload } from "../tasks/task001/duplicates";
import { hashStandardRow } from "../tasks/task001/delivery";
import { normalize, type StandardRow } from "../tasks/task001/geo";
import { errorResponse, jsonResponse } from "../response";
import type { Env, FieldMappingEntryRow, GoogleCellValue } from "../types";

function text(v:unknown):string{return v==null?"":String(v).trim();}
function physicalToStandard(headers:GoogleCellValue[], row:GoogleCellValue[], mappings:FieldMappingEntryRow[]):StandardRow {
  const index=new Map(headers.map((h,i)=>[text(h),i])); const out:StandardRow={};
  for(const m of mappings){const i=index.get(m.source_field);if(i===undefined)continue;const value=row[i]??"";out[m.standard_field]=value as any;}
  return out;
}
async function ensureBootstrapExecution(env:Env, taskId:string):Promise<string>{
  const existing=await env.DB.prepare(`SELECT execution_id FROM execution_instances WHERE source_reference='TASK001_PRODUCTION_BASELINE_BOOTSTRAP' AND task_id=?1 ORDER BY created_at DESC LIMIT 1`).bind(taskId).first<{execution_id:string}>();
  if(existing)return existing.execution_id;
  const task=await getTaskDefinition(env,taskId);if(!task)throw new Error("TASK_NOT_FOUND");const id=`EXE_${crypto.randomUUID()}`,now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO execution_instances (execution_id,task_id,task_version,source_type,source_reference,requested_by_actor_type,requested_by_actor_id,requested_at,status,completed_at,result_code,result_message,idempotency_key,request_hash,request_payload_json,parent_execution_id,correlation_id,created_at,updated_at) VALUES (?1,?2,?3,'SYSTEM','TASK001_PRODUCTION_BASELINE_BOOTSTRAP','SYSTEM','PHASE6_BOOTSTRAP',?4,'SUCCESS',?4,'BASELINE_BOOTSTRAP','Production business-key baseline bootstrap','TASK001_BASELINE_BOOTSTRAP','TASK001_BASELINE_BOOTSTRAP','{}',NULL,NULL,?4,?4)`).bind(id,taskId,task.definition_version,now).run();return id;
}

type BootstrapRole = "GAPP_ORDER" | "SMARTLINK_ORDER_DELIVERY";
type BootstrapResult = {
  role: BootstrapRole;
  resourceId: string;
  rowCount: number;
  snapshotHash: string;
  inserted: number;
  identical: number;
  conflict: number;
  blank: number;
};
type BootstrapProgress = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  executionId: string;
  mappingSetId: string;
  roleIndex: number;
  offset: number;
  results: BootstrapResult[];
};

const BOOTSTRAP_PROGRESS_META_KEY = "task001_business_key_bootstrap_progress_v1";
const BOOTSTRAP_COMPLETE_META_KEY = "task001_business_key_bootstrap_v1";
const BOOTSTRAP_ROLES = [
  { role: "GAPP_ORDER" as const, fieldsMode: "CANONICAL" as const },
  { role: "SMARTLINK_ORDER_DELIVERY" as const, fieldsMode: "DELIVERY" as const },
];
const DEFAULT_BOOTSTRAP_CHUNK_SIZE = 50;
const MAX_BOOTSTRAP_CHUNK_SIZE = 100;

type ExistingBootstrapClaim = {
  business_key_claim_id: string;
  business_key: string;
  payload_hash: string;
  source_execution_id: string;
  status: string;
};

function boundedChunkSize(value: unknown): number {
  const n = Number(value ?? DEFAULT_BOOTSTRAP_CHUNK_SIZE);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BOOTSTRAP_CHUNK_SIZE;
  return Math.min(MAX_BOOTSTRAP_CHUNK_SIZE, Math.max(1, Math.floor(n)));
}

async function loadBootstrapProgress(env: Env): Promise<BootstrapProgress | null> {
  const row = await env.DB.prepare(`SELECT meta_value FROM system_meta WHERE meta_key=?1 LIMIT 1`)
    .bind(BOOTSTRAP_PROGRESS_META_KEY)
    .first<{ meta_value: string }>();
  if (!row?.meta_value) return null;
  try { return JSON.parse(row.meta_value) as BootstrapProgress; }
  catch { throw new Error("BASELINE_BOOTSTRAP_PROGRESS_INVALID"); }
}

async function saveBootstrapProgress(env: Env, progress: BootstrapProgress): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT OR REPLACE INTO system_meta (meta_key,meta_value,updated_at) VALUES (?1,?2,?3)`)
    .bind(BOOTSTRAP_PROGRESS_META_KEY, JSON.stringify(progress), progress.updatedAt)
    .run();
}

async function clearBootstrapProgress(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM system_meta WHERE meta_key=?1`).bind(BOOTSTRAP_PROGRESS_META_KEY).run();
}

async function existingClaimsForKeys(env: Env, namespace: string, keys: string[]): Promise<Map<string, ExistingBootstrapClaim>> {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqueKeys.length) return new Map();
  const placeholders = uniqueKeys.map((_, i) => `?${i + 2}`).join(",");
  const rows = await env.DB.prepare(`
    SELECT business_key_claim_id,business_key,payload_hash,source_execution_id,status
    FROM business_key_claims
    WHERE namespace=?1 AND business_key IN (${placeholders})
  `).bind(namespace, ...uniqueKeys).all<ExistingBootstrapClaim>();
  return new Map((rows.results ?? []).map((row) => [row.business_key, row]));
}

async function processBootstrapChunk(env: Env, input: {
  namespace: string;
  resourceId: string;
  executionId: string;
  rows: Array<{ key: string; hash: string }>;
}): Promise<{ inserted: number; identical: number; conflict: number; claimIdsToCommit: string[] }> {
  const existing = await existingClaimsForKeys(env, input.namespace, input.rows.map((r) => r.key));
  const local = new Map<string, { hash: string; claimId: string | null; kind: "EXISTING" | "NEW" }>();
  const inserts: Array<{ id: string; key: string; hash: string }> = [];
  const claimIdsToCommit: string[] = [];
  let inserted = 0, identical = 0, conflict = 0;
  const now = new Date().toISOString();

  for (const row of input.rows) {
    const seen = local.get(row.key);
    if (seen) {
      if (seen.hash === row.hash) identical += 1;
      else conflict += 1;
      continue;
    }

    const claim = existing.get(row.key);
    if (claim) {
      local.set(row.key, { hash: claim.payload_hash, claimId: claim.business_key_claim_id, kind: "EXISTING" });
      if (claim.status === "COMMITTED" && claim.payload_hash === row.hash) { identical += 1; continue; }
      if (claim.status === "COMMITTED") { conflict += 1; continue; }
      if (claim.status === "CLAIMED" && claim.source_execution_id === input.executionId && claim.payload_hash === row.hash) {
        claimIdsToCommit.push(claim.business_key_claim_id);
        inserted += 1;
        continue;
      }
      conflict += 1;
      continue;
    }

    const id = `BKC_${crypto.randomUUID()}`;
    inserts.push({ id, key: row.key, hash: row.hash });
    claimIdsToCommit.push(id);
    local.set(row.key, { hash: row.hash, claimId: id, kind: "NEW" });
    inserted += 1;
  }

  if (inserts.length) {
    const values: string[] = [];
    const args: unknown[] = [];
    for (const item of inserts) {
      const base = args.length;
      values.push(`(?${base+1},?${base+2},?${base+3},?${base+4},?${base+5},?${base+6},'CLAIMED',?${base+7},?${base+7},NULL)`);
      args.push(item.id,input.namespace,item.key,item.hash,input.executionId,input.resourceId,now);
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO business_key_claims (
        business_key_claim_id, namespace, business_key, payload_hash, source_execution_id,
        canonical_resource_id, status, created_at, updated_at, committed_at
      ) VALUES ${values.join(",")}
    `).bind(...args).run();
  }

  const uniqueClaimIds = [...new Set(claimIdsToCommit)];
  if (uniqueClaimIds.length) {
    const placeholders = uniqueClaimIds.map((_,i)=>`?${i+1}`).join(",");
    await env.DB.prepare(`
      UPDATE business_key_claims
      SET status='COMMITTED', committed_at=?${uniqueClaimIds.length+1}, updated_at=?${uniqueClaimIds.length+1}
      WHERE business_key_claim_id IN (${placeholders}) AND status='CLAIMED'
    `).bind(...uniqueClaimIds,now).run();
  }
  return { inserted, identical, conflict, claimIdsToCommit: uniqueClaimIds };
}

export async function handleTask001BootstrapBusinessKeys(request:Request,env:Env,requestId:string):Promise<Response>{
  let b:any;
  try{b=await request.json();}
  catch{return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);}
  if(String(b?.confirm||"")!=="BOOTSTRAP_PRODUCTION_BASELINE")return errorResponse("CONFIRMATION_REQUIRED","confirm must equal BOOTSTRAP_PRODUCTION_BASELINE",400,requestId);
  try{
    const taskId="task001_smartlink_order";
    const chunkSize=boundedChunkSize(b?.chunkSize);
    const completed=await env.DB.prepare(`SELECT meta_value FROM system_meta WHERE meta_key=?1 LIMIT 1`).bind(BOOTSTRAP_COMPLETE_META_KEY).first<{meta_value:string}>();
    if(completed?.meta_value){
      let marker:any=null;try{marker=JSON.parse(completed.meta_value);}catch{marker=completed.meta_value;}
      return jsonResponse({ok:true,status:"ALREADY_COMPLETED",completed:true,marker},200,requestId);
    }

    const mappingSet=await getPublishedMappingSet(env,taskId);if(!mappingSet)throw new Error("PUBLISHED_MAPPING_NOT_FOUND");
    const entries=await listMappingEntries(env,mappingSet.mapping_set_id);
    const bindings=await listActiveBindings(env,taskId);
    const byRole=new Map(bindings.map(x=>[x.binding_role,x]));
    const executionId=await ensureBootstrapExecution(env,taskId);
    let progress=await loadBootstrapProgress(env);
    if(!progress){
      progress={version:1,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),executionId,mappingSetId:mappingSet.mapping_set_id,roleIndex:0,offset:0,results:[]};
    }
    if(progress.mappingSetId!==mappingSet.mapping_set_id)throw new Error(`BASELINE_MAPPING_CHANGED:${progress.mappingSetId}:${mappingSet.mapping_set_id}`);
    if(progress.executionId!==executionId)throw new Error(`BASELINE_EXECUTION_CHANGED:${progress.executionId}:${executionId}`);
    if(progress.roleIndex<0||progress.roleIndex>=BOOTSTRAP_ROLES.length)throw new Error("BASELINE_BOOTSTRAP_PROGRESS_ROLE_INVALID");

    const spec=BOOTSTRAP_ROLES[progress.roleIndex];
    const binding=byRole.get(spec.role);if(!binding)throw new Error(`BINDING_MISSING:${spec.role}`);
    const resource=await getResource(env,binding.resource_id);if(!resource?.external_id)throw new Error(`RESOURCE_INVALID:${spec.role}`);
    let meta:any={};try{meta=JSON.parse(resource.metadata_json||"{}");}catch{}
    const ds=await readNormalizedSheet(env,resource.external_id,String(meta.sheetName||""),String(meta.range||"A:ZZZ"),Number(meta.headerRow||1));
    const mappings=entries.filter(e=>e.binding_role===spec.role&&e.mapping_direction==="OUTPUT").sort((a,b)=>a.ordinal-b.ordinal);
    let result=progress.results.find((r)=>r.role===spec.role);
    if(!result){
      result={role:spec.role,resourceId:binding.resource_id,rowCount:ds.rowCount,snapshotHash:ds.snapshotHash,inserted:0,identical:0,conflict:0,blank:0};
      progress.results.push(result);
    } else {
      if(result.resourceId!==binding.resource_id)throw new Error(`BASELINE_RESOURCE_CHANGED:${spec.role}`);
      if(result.snapshotHash!==ds.snapshotHash)throw new Error(`BASELINE_SOURCE_CHANGED:${spec.role}`);
    }

    const start=progress.offset;
    const end=Math.min(ds.rows.length,start+chunkSize);
    const prepared:Array<{key:string;hash:string}>=[];
    let blank=0;
    for(const physical of ds.rows.slice(start,end)){
      const row=physicalToStandard(ds.headers,physical,mappings);
      const key=normalize(row.order_id);
      if(!key){blank+=1;continue;}
      const fields=spec.fieldsMode==="CANONICAL"?Object.keys(comparablePayload(row)):mappings.map(m=>m.standard_field);
      prepared.push({key,hash:await hashStandardRow(row,fields)});
    }
    const chunk=await processBootstrapChunk(env,{namespace:`${spec.role}:${binding.resource_id}`,resourceId:binding.resource_id,executionId,rows:prepared});
    result.inserted+=chunk.inserted;
    result.identical+=chunk.identical;
    result.conflict+=chunk.conflict;
    result.blank+=blank;
    if(result.conflict>0)throw new Error(`BASELINE_DUPLICATE_CONFLICT:${spec.role}:${result.conflict}`);

    progress.offset=end;
    let roleCompleted=false;
    if(progress.offset>=ds.rows.length){
      roleCompleted=true;
      progress.roleIndex+=1;
      progress.offset=0;
    }

    if(progress.roleIndex>=BOOTSTRAP_ROLES.length){
      const marker={completedAt:new Date().toISOString(),executionId,mappingSetId:mappingSet.mapping_set_id,results:progress.results};
      await env.DB.prepare(`INSERT OR REPLACE INTO system_meta (meta_key,meta_value,updated_at) VALUES (?1,?2,?3)`).bind(BOOTSTRAP_COMPLETE_META_KEY,JSON.stringify(marker),marker.completedAt).run();
      await clearBootstrapProgress(env);
      return jsonResponse({ok:true,status:"COMPLETED",completed:true,chunkSize,processedRole:spec.role,processedRange:{start,end,total:ds.rows.length},roleCompleted,...marker},200,requestId);
    }

    await saveBootstrapProgress(env,progress);
    const nextSpec=BOOTSTRAP_ROLES[progress.roleIndex];
    return jsonResponse({
      ok:true,
      status:"IN_PROGRESS",
      completed:false,
      chunkSize,
      processedRole:spec.role,
      processedRange:{start,end,total:ds.rows.length},
      roleCompleted,
      nextRole:nextSpec.role,
      nextOffset:progress.offset,
      progress:{roleIndex:progress.roleIndex,offset:progress.offset,results:progress.results},
    },202,requestId);
  }catch(error){return errorResponse("TASK001_BASELINE_BOOTSTRAP_FAILED",error instanceof Error?error.message:String(error),409,requestId);}
}
