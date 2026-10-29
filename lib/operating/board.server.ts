import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readOwnerProposals,readOwnerReports,type OwnerScope} from "@/lib/ai/supervisor/loop/reads.server";
import {buildOperatingBoard,BOARD_PROPOSAL_STATUSES,BOARD_REPORT_STATUSES,type OperatingBoard} from "./board";

/** The board reads experiments through the same owner-scoped reader as the
 * chat's experiment panel. A failed read shows an empty board. */
export async function readOperatingBoard(db:SupabaseClient,scope:OwnerScope,today:string):Promise<OperatingBoard>{
  try{
    const proposals=await readOwnerProposals(db,scope,{statuses:BOARD_PROPOSAL_STATUSES,limit:30});
    const reports=await readOwnerReports(db,scope,proposals.map(p=>p.id),{statuses:BOARD_REPORT_STATUSES,limit:10});
    return buildOperatingBoard(proposals,reports,today);
  }catch{return {running:[],recentReports:[]};}
}
