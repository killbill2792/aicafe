import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosEmployee} from "./types";
vi.mock("server-only",()=>({}));
import {syncCanonicalEmployees} from "./syncEmployees";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const employeeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const posId="toast:"+business+":"+guid;
type Row={
 id:string;display_name:string;pos_team_member_id:string|null;role:string|null;
 active:boolean;default_hourly_wage_cents:number|null;pos_display_name:string|null;
 pos_last_role:string|null;pos_last_wage_cents:number|null;pos_last_active:boolean|null;
};
function fixture(rows:Row[]){
 const writes:Record<string,unknown>[]=[];
 const db={from(table:string){
  const filters:Record<string,unknown>={};
  let pending:Record<string,unknown>|null=null;
  const q={
   select:()=>q,eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
   is:()=>q,
   async then(resolve:(value:unknown)=>unknown){
    if(pending){
     writes.push({...pending});
     if(table==="employees"){
      const target=rows.find(r=>r.id===filters.id);
      if(target)Object.assign(target,pending);
     }
     return resolve({data:null,error:null});
    }
    return resolve({data:table==="employees"?rows:null,error:null});
   },
   update(values:Record<string,unknown>){pending=values;return q;},
   upsert(values:Record<string,unknown>){
    return {select:()=>({single:async()=>{
     const id="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
     rows.push({id,display_name:String(values.display_name),
      pos_team_member_id:String(values.pos_team_member_id),role:String(values.role),
      active:Boolean(values.active),default_hourly_wage_cents:Number(values.default_hourly_wage_cents),
      pos_display_name:String(values.pos_display_name),
      pos_last_role:String(values.pos_last_role),
      pos_last_wage_cents:Number(values.pos_last_wage_cents),
      pos_last_active:Boolean(values.pos_last_active)});
     return {data:{id},error:null};
    }})};
   },
  };
  return q;
 }};
 return {db:db as unknown as SupabaseClient,writes,rows};
}
function manual(name:string,active=true):Row{
 return {id:employeeId,display_name:name,pos_team_member_id:null,role:"Lead",
  active,default_hourly_wage_cents:2400,pos_display_name:null,
  pos_last_role:null,pos_last_wage_cents:null,pos_last_active:null};
}
function adapter(name:string):PosAdapter{
 return {provider:"toast",fetchEmployees:async()=>[{
  posTeamMemberId:posId,displayName:name,posName:name,role:"Barista",
  hourlyWageCents:1900,active:true
 } satisfies PosEmployee]} as unknown as PosAdapter;
}
describe("shared POS roster preserves owner-managed staff",()=>{
 it("links an existing manual name without replacing its formatting, role or wage",async()=>{
  const f=fixture([manual(" María   Lopez ")]);
  const result=await syncCanonicalEmployees(f.db,business,adapter("María Lopez"));
  expect(result).toMatchObject({created:0,linked:1,review:0});
  expect(f.rows[0]).toMatchObject({pos_team_member_id:posId,
   display_name:" María   Lopez ",role:"Lead",default_hourly_wage_cents:2400});
 });
 it("does not reactivate an owner-disabled manual employee on first link",async()=>{
  const f=fixture([manual("María Lopez",false)]);
  const result=await syncCanonicalEmployees(f.db,business,adapter("María Lopez"));
  expect(result).toMatchObject({created:0,linked:1,review:0});
  expect(f.rows).toHaveLength(1);
  expect(f.rows[0]).toMatchObject({active:false,pos_team_member_id:posId,
   display_name:"María Lopez",role:"Lead",default_hourly_wage_cents:2400});
 });
 it("does not reactivate an owner-disabled employee already linked by GUID",async()=>{
  const f=fixture([{...manual("María Lopez",false),
   pos_team_member_id:posId,pos_display_name:"María Lopez",pos_last_active:true}]);
  const result=await syncCanonicalEmployees(f.db,business,adapter("María Lopez"));
  expect(result).toMatchObject({created:0,linked:1});
  expect(f.rows[0].active).toBe(false);
 });
});
