import { getPublishedMappingSet, listMappingEntries } from "../db/field-mappings";
import { listActiveBindings } from "../db/resource-bindings";
import { getResource } from "../db/resources";
import { claimBusinessKey, markBusinessClaimsCommitted } from "../db/business-keys";
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

export async function handleTask001BootstrapBusinessKeys(request:Request,env:Env,requestId:string):Promise<Response>{
  let b:any;try{b=await request.json();}catch{return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);}if(String(b?.confirm||"")!=="BOOTSTRAP_PRODUCTION_BASELINE")return errorResponse("CONFIRMATION_REQUIRED","confirm must equal BOOTSTRAP_PRODUCTION_BASELINE",400,requestId);
  try{
    const taskId="task001_smartlink_order",mappingSet=await getPublishedMappingSet(env,taskId);if(!mappingSet)throw new Error("PUBLISHED_MAPPING_NOT_FOUND");const entries=await listMappingEntries(env,mappingSet.mapping_set_id);const bindings=await listActiveBindings(env,taskId);const byRole=new Map(bindings.map(x=>[x.binding_role,x]));const executionId=await ensureBootstrapExecution(env,taskId);
    const specs=[{role:"GAPP_ORDER",fieldsMode:"CANONICAL"},{role:"SMARTLINK_ORDER_DELIVERY",fieldsMode:"DELIVERY"}] as const;const results:any[]=[];
    for(const spec of specs){const binding=byRole.get(spec.role);if(!binding)throw new Error(`BINDING_MISSING:${spec.role}`);const resource=await getResource(env,binding.resource_id);if(!resource?.external_id)throw new Error(`RESOURCE_INVALID:${spec.role}`);let meta:any={};try{meta=JSON.parse(resource.metadata_json||"{}");}catch{}const ds=await readNormalizedSheet(env,resource.external_id,String(meta.sheetName||""),String(meta.range||"A:ZZZ"),Number(meta.headerRow||1));const mappings=entries.filter(e=>e.binding_role===spec.role&&e.mapping_direction==="OUTPUT").sort((a,b)=>a.ordinal-b.ordinal);let inserted=0,identical=0,conflict=0,blank=0;
      for(const physical of ds.rows){const row=physicalToStandard(ds.headers,physical,mappings);const key=normalize(row.order_id);if(!key){blank+=1;continue;}const fields=spec.fieldsMode==="CANONICAL"?Object.keys(comparablePayload(row)):mappings.map(m=>m.standard_field);const hash=await hashStandardRow(row,fields);const decision=await claimBusinessKey(env,{namespace:`${spec.role}:${binding.resource_id}`,businessKey:key,payloadHash:hash,executionId,resourceId:binding.resource_id});if(decision.kind==="NEW"){await markBusinessClaimsCommitted(env,[decision.claim.business_key_claim_id]);inserted+=1;}else if(decision.kind==="IDENTICAL")identical+=1;else if(decision.kind==="CONFLICT")conflict+=1;else throw new Error(`BASELINE_KEY_BLOCKED:${spec.role}:${key}:${decision.claim.status}`);}
      results.push({role:spec.role,resourceId:binding.resource_id,rowCount:ds.rowCount,snapshotHash:ds.snapshotHash,inserted,identical,conflict,blank});if(conflict>0)throw new Error(`BASELINE_DUPLICATE_CONFLICT:${spec.role}:${conflict}`);
    }
    const marker={completedAt:new Date().toISOString(),executionId,mappingSetId:mappingSet.mapping_set_id,results};
    await env.DB.prepare(`INSERT OR REPLACE INTO system_meta (meta_key,meta_value,updated_at) VALUES ('task001_business_key_bootstrap_v1',?1,?2)`).bind(JSON.stringify(marker),new Date().toISOString()).run();
    return jsonResponse({ok:true,...marker},200,requestId);
  }catch(error){return errorResponse("TASK001_BASELINE_BOOTSTRAP_FAILED",error instanceof Error?error.message:String(error),409,requestId);}
}
