import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readOwnerMonitorSamples,readOwnerPriceMonitorProposals,readOwnerPriceMonitorReports,
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
  const [reports,samples]=await Promise.all([
    readOwnerPriceMonitorReports(db,scope,ids,BOARD_REPORT_STATUSES),
    readOwnerMonitorSamples(db,scope,ids),
  ]);
  return buildExperimentsList(proposals,reports,samples,today);
}
