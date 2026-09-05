import { task001CutoverReadiness } from "../tasks/task001/cutover";
import { jsonResponse } from "../response";
import type { Env } from "../types";
export async function handleTask001CutoverPreflight(env:Env,requestId:string):Promise<Response>{return jsonResponse({ok:true,...await task001CutoverReadiness(env)},200,requestId);}
