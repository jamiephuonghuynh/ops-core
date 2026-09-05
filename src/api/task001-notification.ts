import { recoverTask001DeliveryNotificationOutbox } from "../tasks/task001/notification";
import { processNotificationBacklog } from "../notification/runtime";
import { errorResponse, jsonResponse } from "../response";
import type { Env } from "../types";
export async function handleTask001RecoverNotificationOutbox(env:Env,requestId:string):Promise<Response>{try{const recovered=await recoverTask001DeliveryNotificationOutbox(env,100);const delivered=await processNotificationBacklog(env,{taskId:"task001_smartlink_order",limit:50});return jsonResponse({ok:true,...recovered,backlog:delivered},200,requestId);}catch(error){return errorResponse("TASK001_NOTIFICATION_OUTBOX_RECOVERY_FAILED",error instanceof Error?error.message:String(error),500,requestId);}}
