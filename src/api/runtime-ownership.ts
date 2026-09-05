import { getTaskRuntimeOwnership, setTaskRuntimeOwnership } from "../db/runtime-ownership";
import { errorResponse, jsonResponse } from "../response";
import { task001CutoverReadiness } from "../tasks/task001/cutover";
import type { Env, RuntimeOwner } from "../types";
function text(v:unknown):string{return v==null?"":String(v).trim();}
export async function handleGetRuntimeOwnership(env:Env,taskId:string,requestId:string):Promise<Response>{const row=await getTaskRuntimeOwnership(env,taskId);if(!row)return errorResponse("RUNTIME_OWNERSHIP_NOT_FOUND","Runtime ownership was not found",404,requestId);return jsonResponse({ok:true,ownership:row},200,requestId);}
export async function handleSetRuntimeOwnership(request:Request,env:Env,taskId:string,requestId:string):Promise<Response>{
  let b:any;try{b=await request.json();}catch{return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);}
  const owner=text(b.runtimeOwner) as RuntimeOwner;
  if(!["LEGACY_APPS_SCRIPT","CLOUDFLARE"].includes(owner))return errorResponse("INVALID_RUNTIME_OWNER","runtimeOwner must be LEGACY_APPS_SCRIPT or CLOUDFLARE",400,requestId);
  if(taskId==="task001_smartlink_order"){
    const readiness=await task001CutoverReadiness(env);
    if(owner==="CLOUDFLARE"&&!readiness.cutoverPrepared)return errorResponse("TASK001_CUTOVER_NOT_PREPARED","Task001 cannot move to CLOUDFLARE until cutover preflight is prepared",409,requestId,{preflight:readiness});
    if(owner==="LEGACY_APPS_SCRIPT"&&!readiness.rollbackSafe)return errorResponse("TASK001_ROLLBACK_NOT_SAFE","Task001 cannot move back to legacy while external side-effect state is UNKNOWN",409,requestId,{preflight:readiness});
  }
  const row=await setTaskRuntimeOwnership(env,{taskId,runtimeOwner:owner,changedBy:text(b.changedBy)||null,reason:text(b.reason)||null});
  return jsonResponse({ok:true,ownership:row},200,requestId);
}
