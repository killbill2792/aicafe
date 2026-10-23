import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { requireAdmin } from "./auth.server";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type CostMetric={turns:number;priced_turns:number;input_tokens:number;output_tokens:number;known_cost_usd:number};
export type CostGroup=CostMetric&{business_id?:string;name?:string;day?:string;topic?:string};
export type CostTurn={id:string;business_id:string;name:string;started_at:string;question_topic:string|null;input_tokens:number|null;output_tokens:number|null;cost_usd:number};
export type CostRollup={totals:CostMetric;cafes:CostGroup[];days:CostGroup[];topics:CostGroup[];top_turns:CostTurn[]};
export type TopicStat={topic:string;questions:number;cafes:number;common_local_hour:number|null;avg_cost_usd:number|null;priced_questions:number};
export type TopicDay={day:string;topic:string;questions:number;cafes:number};
export type PatternRollup={topics:TopicStat[];daily:TopicDay[];pending:number;suggestions:string[]};
export type ProactiveCafe={
  business_id:string;name:string;in_app_created:number;in_app_opened:number;in_app_acted:number;
  in_app_dismissed:number;outbound_sent:number;outbound_failed:number;outbound_pending:number;
};
export type ProactiveUpdate={id:string;business_id:string;domain:string;kind:string;severity:string;
  text:string;status:"new"|"seen"|"acted"|"dismissed";notified_at:string|null;created_at:string};
export type ProactiveDelivery={id:string;business_id:string;task_id:string;state:"reserved"|"sent"|"failed";
  task_status:string;created_at:string;sent_at:string|null;failure_code:string|null};
export type ProactiveRollup={cafes:ProactiveCafe[];recent_updates:ProactiveUpdate[];recent_deliveries:ProactiveDelivery[]};
function requireResult<T>(data:unknown,error:{message:string}|null):T {
  if(error)throw error;
  if(!data || typeof data!=="object")throw new Error("admin_analytics_unavailable");
  return data as T;
}
export async function getAdminCosts():Promise<CostRollup>{
  await requireAdmin();
  const {data,error}=await createAdminSupabaseClient().rpc("admin_cost_rollup");
  return requireResult(data,error);
}
export async function getAdminPatterns():Promise<PatternRollup>{
  await requireAdmin();
  const client=createAdminSupabaseClient();
  const [{data,error},{data:suggestions,error:suggestionError}]=await Promise.all([
    client.rpc("admin_pattern_rollup"),
    client.from("admin_home_card_suggestions").select("topic").eq("status","suggested"),
  ]);
  if(suggestionError)throw suggestionError;
  return {...requireResult<Omit<PatternRollup,"suggestions">>(data,error),
    suggestions:(suggestions??[]).map(s=>String(s.topic))};
}
export async function getAdminProactive(cafe?:string):Promise<ProactiveRollup>{
  await requireAdmin();
  if(cafe && !UUID.test(cafe)) return {cafes:[],recent_updates:[],recent_deliveries:[]};
  const {data,error}=await createAdminSupabaseClient().rpc("admin_proactive_rollup",{p_cafe:cafe??null});
  return requireResult(data,error);
}
