import {randomUUID} from "node:crypto";
import {Client} from "pg";
import type {SupabaseClient} from "@supabase/supabase-js";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {cafeNotesContext,cafeNotesPort} from "./notes.server";
import {executeResearchTool} from "./tools.server";

// Migrated disposable local database only; never a real café database.
const url=process.env.SUPERVISOR_RESEARCH_DB_URL??"";
const enabled=url!=="";
if(enabled&&!["localhost","127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("café notes DB test only runs against a local disposable database");

let admin:Client;
const cafe=randomUUID(),otherCafe=randomUUID(),owner=randomUUID(),stranger=randomUUID();

/** Runs RPCs and table reads the way PostgREST does for a signed-in owner: role authenticated, that user's claims. */
function asUser(userId:string):SupabaseClient{
  const run=async<T>(work:(db:Client)=>Promise<T>)=>{
    const db=new Client({connectionString:url});await db.connect();
    try{
      await db.query("begin");
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:userId,role:"authenticated"})]);
      await db.query("set local role authenticated");
      const out=await work(db);await db.query("commit");return out;
    }catch(error){await db.query("rollback").catch(()=>undefined);throw error;}
    finally{await db.end();}
  };
  return {
    rpc:async(name:string,params:Record<string,unknown>)=>{
      try{
        const keys=Object.keys(params);
        const r=await run(db=>db.query("select public."+name+"("+keys.map((_,i)=>"$"+(i+1)).join(",")+") as data",keys.map(k=>params[k])));
        return {data:r.rows[0].data,error:null};
      }catch(error){return {data:null,error:{message:error instanceof Error?error.message:String(error)}};}
    },
    from:(table:string)=>{
      const filters:string[]=[];const values:unknown[]=[];
      const q={select:()=>q,eq:(c:string,v:unknown)=>{values.push(v);filters.push(c+"=$"+values.length);return q;},
        is:(c:string)=>{filters.push(c+" is null");return q;},order:()=>q,
        then:(ok:(v:unknown)=>unknown)=>run(db=>db.query("select * from public."+table+(filters.length?" where "+filters.join(" and "):"")+" order by created_at",values))
          .then(r=>({data:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),error:null}),e=>({data:null,error:{message:String(e)}})).then(ok)};
      return q;
    },
  } as unknown as SupabaseClient;
}

beforeAll(async()=>{
  if(!enabled)return;
  admin=new Client({connectionString:url});await admin.connect();
  for(const uid of [owner,stranger])
    await admin.query("insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) "+
      "values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),now())",[uid,uid+"@example.invalid"]);
  for(const id of [cafe,otherCafe])
    await admin.query("insert into public.businesses(id,name,timezone,currency) values ($1,'Notes cafe','Europe/Madrid','EUR')",[id]);
  await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$3,'owner'),($2,$4,'owner')",[cafe,otherCafe,owner,stranger]);
});
afterAll(async()=>{
  if(!enabled)return;
  await admin.query("delete from public.cafe_notes where business_id = any($1)",[[cafe,otherCafe]]);
  await admin.query("delete from public.memberships where business_id = any($1)",[[cafe,otherCafe]]);
  await admin.query("delete from public.businesses where id = any($1)",[[cafe,otherCafe]]);
  await admin.query("delete from auth.users where id = any($1)",[[owner,stranger]]);
  await admin.end();
});

describe.skipIf(!enabled)("café notes",()=>{
  it("saves, updates by topic, keeps history, forgets, and shows each note's source and date to the model",async()=>{
    const port=cafeNotesPort(asUser(owner),cafe);
    await port.save("busy_hours","Weekday rush is 8-10am.","sales by hour, 2026-11-25");
    await port.save("busy_hours","Weekday rush is 7-9am.","sales by hour, 2026-12-02");
    const current=await admin.query("select note from public.cafe_notes where business_id=$1 and retired_at is null",[cafe]);
    expect(current.rows).toEqual([{note:"Weekday rush is 7-9am."}]);
    expect((await admin.query("select count(*)::int n from public.cafe_notes where business_id=$1",[cafe])).rows[0].n).toBe(2); // history kept
    const text=await cafeNotesContext(asUser(owner),cafe,[{fact_key:"ingredient_cost_percent",value_json:20,created_at:"2026-10-01T00:00:00Z",unit:null,period_scope:null}],"2026-12-02");
    expect(text).toContain("busy_hours: Weekday rush is 7-9am.");
    expect(text).toContain("learned from: sales by hour, 2026-12-02");
    expect(text).toContain("the owner saved this on 2026-10-01");
    expect(text).not.toContain("8-10am");
    expect(await port.forget("busy_hours")).toBe(true);
    expect(await port.forget("busy_hours")).toBe(false);
  });

  it("is private to the café owner: other cafés cannot read or write it",async()=>{
    await cafeNotesPort(asUser(owner),cafe).save("habit","Prefers oat milk deliveries on Monday.","owner said so, 2026-11-25");
    await expect(cafeNotesPort(asUser(stranger),cafe).save("x","hijack","none")).rejects.toThrow();
    await expect(cafeNotesPort(asUser(stranger),cafe).forget("habit")).rejects.toThrow();
    expect(await cafeNotesContext(asUser(stranger),cafe,[],"2026-11-25")).toContain("none yet");
  });

  it("is reachable through the research tools and validates the topic",async()=>{
    const scope={db:{} as SupabaseClient,businessId:cafe,ownerUserId:owner,notes:cafeNotesPort(asUser(owner),cafe)};
    expect(await executeResearchTool(scope,"remember_cafe_note",JSON.stringify({topic:"Bad Topic!",note:"n",basis:"b"}))).toMatchObject({ok:false});
    expect(await executeResearchTool(scope,"remember_cafe_note",JSON.stringify({topic:"staff.break_habits",note:"Carla skips the break on slow days.",basis:"timecards, last 14 days"}))).toMatchObject({ok:true,saved:"staff.break_habits"});
    expect(await executeResearchTool({...scope,notes:undefined},"remember_cafe_note",JSON.stringify({topic:"a",note:"n",basis:"b"}))).toMatchObject({ok:false});
  });
});
