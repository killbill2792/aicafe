import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readOwnerMonitorSamples,readOwnerPriceMonitorProposals,readOwnerPriceMonitorReports,readOwnerVerifiedPriceWindows,
  type OwnerScope} from "@/lib/ai/supervisor/loop/reads.server";
import {BOARD_PROPOSAL_STATUSES,BOARD_REPORT_STATUSES,DRINK_PRICE_EXPERIMENT_CAPABILITY,GOAL_CAPABILITY} from "./board";
import {buildExperimentsList,type ExperimentsList} from "./experiments";

/** Price tests, plain price changes with a watch window, and goals. Event-day plans have
 * their own Events panel (AGENTS.md / Events Fix C) and are not repeated here. */
export const EXPERIMENT_CAPABILITIES=[DRINK_PRICE_EXPERIMENT_CAPABILITY,"alex.menu_price_change.v1",GOAL_CAPABILITY] as const;

/** Uncapped read through the same owner-scoped Supervisor readers as the board and chat. */
export async function readExperiments(db:SupabaseClient,scope:OwnerScope,today:string):Promise<ExperimentsList>{
  const proposals=await readOwnerPriceMonitorProposals(db,scope,EXPERIMENT_CAPABILITIES,BOARD_PROPOSAL_STATUSES);
  const ids=proposals.map(p=>p.id);
  const [reports,samples,windows]=await Promise.all([
    readOwnerPriceMonitorReports(db,scope,ids,BOARD_REPORT_STATUSES),
    readOwnerMonitorSamples(db,scope,ids),
    readOwnerVerifiedPriceWindows(db,scope,ids),
  ]);
  const starts=new Map(windows.map(w=>[w.source_id,w.start_at]));
  return buildExperimentsList(proposals.map(p=>({...p,
    verified_window_start_at:starts.get(p.id)??null})),reports,samples,today,new Date().toISOString());
}
