import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeTeamUpdate } from "./write.server";
const state=vi.hoisted(()=>({ inserted:true, member:true, rows:[] as Record<string,unknown>[] }));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:(table:string)=>{
 if(table==="memberships"){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:state.member?{user_id:"yes"}:null,error:null})};return q;}
 if(table==="team_updates")return {upsert:(row:Record<string,unknown>, opts:Record<string,unknown>)=>{state.rows.push({...row,...opts});return {select:()=>({maybeSingle:async()=>({data:state.inserted?{id:"id"}:null,error:null})})};}};
 throw Error("unexpected table");
}})}));
const input={businessId:"11111111-1111-4111-8111-111111111111",ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",domain:"menu_pricing" as const,kind:"review",severity:"attention" as const,subjectType:"menu_item",text:"Review price",locale:"en" as const,actions:[{kind:"open" as const}],dedupeKey:"item:review"};
beforeEach(()=>{state.inserted=true;state.member=true;state.rows.length=0;});
describe("team updates writer",()=>{
 it("dedupes on business and key",async()=>{expect(await writeTeamUpdate(input)).toEqual({created:true});state.inserted=false;expect(await writeTeamUpdate(input)).toEqual({created:false});expect(state.rows).toHaveLength(2);expect(state.rows[0]).toMatchObject({agent_id:"alex",onConflict:"business_id,dedupe_key",ignoreDuplicates:true});});
 it.each([["menu_pricing","alex"],["labor","olivia"],["supplies","maya"],["money","leo"]] as const)("uses mapped persona %s",async(domain,agent)=>{await writeTeamUpdate({...input,domain});expect(state.rows[0].agent_id).toBe(agent);});
 it("rejects invalid action kind",async()=>{await expect(writeTeamUpdate({...input,actions:[{kind:"unsafe" as "open"}]})).rejects.toThrow();expect(state.rows).toHaveLength(0);});
 it("denies a non-owner",async()=>{state.member=false;await expect(writeTeamUpdate(input)).rejects.toThrow("owner membership");expect(state.rows).toHaveLength(0);});
 it("enforces text length",async()=>{await expect(writeTeamUpdate({...input,text:"x".repeat(601)})).rejects.toThrow();});
});