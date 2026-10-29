import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:vi.fn()}));
import {postGoalCheckin,readGoalCheckins,recordGoalCheckin,checkinTaskId} from "./goalCheckins.server";
import {goalEffectSchema} from "@/lib/calc/goals/goalSpec";

type Row=Record<string,unknown>&{id:string};
/** In-memory stand-in for the two tables, enough for these queries. */
function fakeDb(){
  const tables:Record<string,Row[]>={operating_tasks:[],ai_messages:[]};
  const from=(name:string)=>{
    const rows=tables[name];
    const filters:Array<(r:Row)=>boolean>=[];
    const q={
      upsert:async(row:Row,opts:{ignoreDuplicates?:boolean})=>{
        if(!rows.some(r=>r.id===row.id))rows.push({created_at:String(rows.length),...row});
        else if(!opts.ignoreDuplicates)Object.assign(rows.find(r=>r.id===row.id)!,row);
        return {error:null};
      },
      insert:async(row:Row)=>rows.some(r=>r.id===row.id)?{error:{code:"23505"}}:(rows.push(row),{error:null}),
      update:(patch:Row)=>{const u={eq:(k:string,v:unknown)=>{filters.push(r=>r[k]===v);return u;},
        neq:(k:string,v:unknown)=>{filters.push(r=>r[k]!==v);return u;},
        then:(res:(v:unknown)=>void)=>{rows.filter(r=>filters.every(f=>f(r))).forEach(r=>Object.assign(r,patch));res({error:null});}};
        return u;},
      select:()=>q,
      eq:(k:string,v:unknown)=>{filters.push(r=>r[k]===v);return q;},
      like:(k:string,p:string)=>{filters.push(r=>String(r[k]).startsWith(p.replace("%","")));return q;},
      order:()=>q,
      limit:async()=>({data:rows.filter(r=>filters.every(f=>f(r))).reverse(),error:null}),
    };
    return q;
  };
  return {tables,db:{from} as never};
}
const scope={businessId:"b0000000-0000-4000-8000-000000000001",ownerUserId:"a0000000-0000-4000-8000-000000000001",
  threadId:"c0000000-0000-4000-8000-000000000001",locale:"en" as const};
const goalId="d0000000-0000-4000-8000-000000000001";
const effect=goalEffectSchema.parse({title:"Average ticket up 5%",days:14,proposedOn:"2026-10-01",
  baselineFrom:"2026-09-17",baselineTo:"2026-09-30",currency:"USD",
  checkin:{question:"Did guests mention the new pastry?",cadence:"weekly",audience:"owner"},
  metrics:[{id:"primary",role:"primary",metricKey:"avg_ticket",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:5}]});

describe("goal check-ins store",()=>{
  it("posts one inbox item and one chat message per goal day, even when run twice",async()=>{
    const {db,tables}=fakeDb();
    expect(await postGoalCheckin(db,scope,goalId,effect,"2026-10-02")).toBe(true);
    expect(await postGoalCheckin(db,scope,goalId,effect,"2026-10-02")).toBe(false);
    expect(tables.operating_tasks).toHaveLength(1);
    expect(tables.ai_messages).toHaveLength(1);
    expect(tables.operating_tasks[0]).toMatchObject({id:checkinTaskId(effect,"2026-10-02"),kind:"goal_checkin",
      status:"needs_owner",entity_id:goalId,payload:{question:"Did guests mention the new pastry?",threadId:scope.threadId}});
    expect(JSON.stringify(tables.ai_messages[0].structured_content)).toContain("Reply yes, somewhat or no");
  });
  it("saves the answer on the latest open check-in and reads it back",async()=>{
    const {db}=fakeDb();
    await postGoalCheckin(db,scope,goalId,effect,"2026-10-02");
    await postGoalCheckin(db,scope,goalId,effect,"2026-10-09");
    const saved=await recordGoalCheckin(db,scope,goalId,effect,{date:null,answer:"somewhat",note:"Two asked"});
    expect(saved).toEqual({id:checkinTaskId(effect,"2026-10-09"),date:"2026-10-09",answer:"somewhat"});
    const rows=await readGoalCheckins(db,scope.businessId,effect);
    expect(rows.find(r=>r.date==="2026-10-09")).toMatchObject({answer:"somewhat",note:"Two asked"});
    expect(rows.find(r=>r.date==="2026-10-02")?.answer).toBeNull();
    // The older unanswered question closed when the newer one was posted.
    expect(rows).toHaveLength(2);
  });
  it("closes older unanswered check-ins when a new one is posted",async()=>{
    const {db,tables}=fakeDb();
    await postGoalCheckin(db,scope,goalId,effect,"2026-10-02");
    await postGoalCheckin(db,scope,goalId,effect,"2026-10-09");
    expect(tables.operating_tasks.map(r=>r.status)).toEqual(["handled","needs_owner"]);
  });
  it("finds nothing to answer for another goal",async()=>{
    const {db}=fakeDb();
    await postGoalCheckin(db,scope,goalId,effect,"2026-10-02");
    expect(await recordGoalCheckin(db,scope,"e0000000-0000-4000-8000-000000000001",effect,
      {date:null,answer:"yes",note:null})).toBeNull();
  });
});
