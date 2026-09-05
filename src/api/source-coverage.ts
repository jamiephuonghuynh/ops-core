import { commitSourceCoverage, initializeSourceCoverage, resolveSourcePeriod } from "../db/source-coverage";
import { errorResponse, jsonResponse } from "../response";
import { ensureAutomationRun, updateAutomationRun } from "../db/automation-runs";
import { getTaskRuntimeOwnership } from "../db/runtime-ownership";
import type { Env } from "../types";

async function body(request: Request): Promise<Record<string, unknown> | null> { try { const v = await request.json(); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } }
function text(v: unknown): string { return v == null ? "" : String(v).trim(); }

export async function handleResolveSourceCoverage(request: Request, env: Env, requestId: string): Promise<Response> {
  const b = await body(request); if (!b) return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);
  const taskId=text(b.taskId), runDate=text(b.runDate), sourceRole=text(b.sourceRole)||"GAPP_EXPORT";
  if(!taskId||!runDate) return errorResponse("INVALID_REQUEST","taskId and runDate are required",400,requestId);
  try { return jsonResponse({ ok:true, ...(await resolveSourcePeriod(env,{taskId,sourceRole,runDate})) },200,requestId); }
  catch(error){ return errorResponse("SOURCE_COVERAGE_RESOLVE_FAILED",error instanceof Error?error.message:String(error),409,requestId); }
}

export async function handleCommitSourceCoverage(request: Request, env: Env, requestId: string): Promise<Response> {
  const b = await body(request); if(!b) return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);
  const taskId=text(b.taskId), sourceRole=text(b.sourceRole)||"GAPP_EXPORT", sourceStartDate=text(b.sourceStartDate), sourceEndDate=text(b.sourceEndDate), coverageType=text(b.coverageType);
  if(!taskId||!sourceStartDate||!sourceEndDate||!coverageType) return errorResponse("INVALID_REQUEST","taskId, sourceStartDate, sourceEndDate and coverageType are required",400,requestId);
  const executionId=text(b.executionId)||null;
  if(!executionId && coverageType!=="SOURCE_EMPTY_CONFIRMED") return errorResponse("SOURCE_COVERAGE_TYPE_INVALID","External coverage commit without executionId is allowed only for SOURCE_EMPTY_CONFIRMED",409,requestId);
  if(!executionId){const owner=await getTaskRuntimeOwnership(env,taskId);if(owner?.runtime_owner!=="CLOUDFLARE")return errorResponse("TASK_RUNTIME_NOT_OWNED","Task runtime ownership is not CLOUDFLARE",409,requestId,{runtimeOwner:owner?.runtime_owner??null});}
  try {
    const committed=await commitSourceCoverage(env,{taskId,sourceRole,sourceStartDate,sourceEndDate,coverageType,executionId,resourceId:text(b.resourceId)||null});
    const runDate=text(b.runDate),runSlot=text(b.runSlot)||"RUN_0800";
    if(!executionId&&runDate){await ensureAutomationRun(env,{taskId,runDate,runSlot,automationId:text(b.automationId)||null,requestId:text(b.requestId)||requestId,sourceStartDate,sourceEndDate});await updateAutomationRun(env,taskId,runDate,runSlot,{status:"SUCCESS",resultCode:"SOURCE_EMPTY_CONFIRMED",automationId:text(b.automationId)||null,requestId:text(b.requestId)||requestId,sourceStartDate,sourceEndDate});}
    return jsonResponse({ok:true,sourceStartDate,sourceEndDate,coverageType,...committed},200,requestId);
  }
  catch(error){ return errorResponse("SOURCE_COVERAGE_COMMIT_FAILED",error instanceof Error?error.message:String(error),409,requestId); }
}

export async function handleInitializeSourceCoverage(request: Request, env: Env, requestId: string): Promise<Response> {
  const b=await body(request); if(!b) return errorResponse("INVALID_REQUEST","JSON body required",400,requestId);
  const taskId=text(b.taskId), sourceRole=text(b.sourceRole)||"GAPP_EXPORT", lastCoveredDate=text(b.lastCoveredDate);
  if(!taskId||!lastCoveredDate) return errorResponse("INVALID_REQUEST","taskId and lastCoveredDate are required",400,requestId);
  try { const state=await initializeSourceCoverage(env,{taskId,sourceRole,lastCoveredDate,coverageType:text(b.coverageType)||"BOOTSTRAP"}); return jsonResponse({ok:true,state},201,requestId); }
  catch(error){ return errorResponse("SOURCE_COVERAGE_INITIALIZE_FAILED",error instanceof Error?error.message:String(error),409,requestId); }
}
