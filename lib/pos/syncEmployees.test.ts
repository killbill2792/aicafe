import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosEmployee} from "./types";
vi.mock("server-only",()=>({}));
import {syncCanonicalEmployees} from "./syncEmployees";

type Staff={
 id:string;business_id:string;display_name:string;pos_team_member_id:string|null;
 role:string|null;active:boolean;default_hourly_wage_cents:number|null;
 pos_display_name:string|null;pos_last_role:string|null;
 pos_last_wage_cents:number|null;pos_last_active:boolean|null;
};
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const location="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const other="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pos=(guid:string,loc=location)=>"toast:"+loc+":"+guid;
const adapter=(provider:"toast"|"square"="toast")=>({provider,
 fetchEmployees:async()=>[]}) as unknown as PosAdapter;
const person=(id:string,name:string,extra:Partial<PosEmployee>={}):PosEmployee=>({
 posTeamMemberId:pos(id),displayName:name,posName:name,active:true,
 role:"Barista",hourlyWageCents:1800,...extra
});
const manual=(id:string,name:string,more:Partial<Staff>={}):Staff=>({
 id,business_id:business,display_name:name,pos_team_member_id:null,
 role:null,active:true,default_hourly_wage_cents:null,pos_display_name:null,
 pos_last_role:null,pos_last_wage_cents:null,pos_last_active:null,...more
});
function fixture(start:Staff[]=[]){
 const rows=start.map(x=>({...x})),reviews:Array<Record<string,unknown>>=[];
 let writes=0;
 const db={from(table:string){
  let mode="select",payload:Record<string,unknown>={};
  const filters:Record<string,unknown>={};
  const q={
   select:()=>q,
   eq:(key:string,value:unknown)=>{filters[key]=value;return q;},
   is:(key:string,value:unknown)=>{filters[key]=value;return q;},
   update:(data:Record<string,unknown>)=>{mode="update";payload=data;return q;},
   upsert:(data:Record<string,unknown>)=>{mode="upsert";payload=data;return q;},
   async single(){return execute();},
   then(ok:(value:unknown)=>unknown,fail?:(error:unknown)=>unknown){
    return Promise.resolve().then(execute).then(ok,fail);
   }
  };
  function execute(){
   if(table==="employees"){
    const selected=rows.filter(r=>Object.entries(filters).every(([k,v])=>
     r[k as keyof Staff]===v));
    if(mode==="select")return {data:selected.map(r=>({...r})),error:null};
    if(mode==="update"){
     writes++;for(const row of selected)Object.assign(row,payload);
     return {error:null};
    }
    if(mode==="upsert"){
     let row=rows.find(r=>r.business_id===payload.business_id&&
      r.pos_team_member_id===payload.pos_team_member_id);
     if(!row){row=manual("new-"+(rows.length+1),String(payload.display_name));
       rows.push(row);}
     Object.assign(row,payload);writes++;
     return {data:{id:row.id},error:null};
    }
   }
   if(table==="pos_import_reviews"){reviews.push(payload);writes++;return {error:null};}
   if(table==="toast_employee_directory")return {error:null};
   throw new Error("Unexpected DB table "+table);
  }
  return q;
 }} as unknown as SupabaseClient;
 return {db,rows,reviews,get writes(){return writes;}};
}
describe("shared POS employee identity and owner-protection",()=>{
 it("imports a 5-person roster including a deleted person without second-run writes",async()=>{
  const f=fixture(),people=[person("1","A"),person("2","B"),
    person("3","C"),person("4","D"),person("5","E",{active:false})];
  expect((await syncCanonicalEmployees(f.db,business,adapter(),people,
   {restaurantGuid:location})).created).toBe(5);
  expect(f.rows.filter(r=>r.active)).toHaveLength(4);
  expect(f.rows.filter(r=>!r.active)).toHaveLength(1);
  const writes=f.writes;
  const rerun=await syncCanonicalEmployees(f.db,business,adapter(),people,
   {restaurantGuid:location});
  expect(rerun).toMatchObject({created:0,updated:0,review:0});
  expect(f.writes).toBe(writes);
 });
 it("links a unique manual identity without rewriting a manually formatted name",async()=>{
  const f=fixture([manual("owner-maria","  MARIA  ",{active:false})]);
  const result=await syncCanonicalEmployees(f.db,business,adapter(),
   [person("maria","Maria")],{restaurantGuid:location});
  expect(result).toMatchObject({created:0,linked:1,review:0});
  expect(f.rows).toHaveLength(1);
  expect(f.rows[0]).toMatchObject({id:"owner-maria",display_name:"  MARIA  ",
   pos_team_member_id:pos("maria"),pos_display_name:"Maria",active:false});
 });
 it("creates one review, not a duplicate, when manual names are ambiguous",async()=>{
  const f=fixture([manual("a","Maria"),manual("b","maria")]);
  const result=await syncCanonicalEmployees(f.db,business,adapter(),
   [person("maria","Maria")],{restaurantGuid:location});
  expect(result).toMatchObject({created:0,review:1});
  expect(f.rows).toHaveLength(2);
  expect(f.reviews).toHaveLength(1);
  expect(f.reviews[0].review_type).toBe("staff_identity");
 });
 it("preserves an owner's name, role, wage, and inactive decision",async()=>{
  const f=fixture([manual("a","My Maria",{
   pos_team_member_id:pos("maria"),pos_display_name:"Maria",
   role:"Shift lead",pos_last_role:"Barista",
   default_hourly_wage_cents:2500,pos_last_wage_cents:1800,
   active:false,pos_last_active:true
  })]);
  await syncCanonicalEmployees(f.db,business,adapter(),
   [person("maria","Maria Changed",{role:"Manager",hourlyWageCents:2200})],
   {restaurantGuid:location});
  expect(f.rows[0]).toMatchObject({display_name:"My Maria",
    role:"Shift lead",default_hourly_wage_cents:2500,active:false,
    pos_display_name:"Maria Changed",pos_last_role:"Manager",pos_last_wage_cents:2200});
 });
 it("a second Toast location's missing staff remain active",async()=>{
  const f=fixture([manual("other","Other location",{pos_team_member_id:pos("other",other),
   pos_last_active:true,pos_display_name:"Other location"})]);
  await syncCanonicalEmployees(f.db,business,adapter(),[],
   {restaurantGuid:location});
  expect(f.rows[0].active).toBe(true);
  expect(f.writes).toBe(0);
 });
 it("Square import never blanks an owner's role when source role is missing",async()=>{
  const f=fixture([manual("square-id","Owner role",{pos_team_member_id:"square:1",
    role:"Lead",pos_last_role:null})]);
  await syncCanonicalEmployees(f.db,business,adapter("square"),[
   {...person("ignored","Owner role"),posTeamMemberId:"square:1",role:null}
  ]);
  expect(f.rows[0].role).toBe("Lead");
 });
});
