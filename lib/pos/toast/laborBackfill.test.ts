import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {backfillToastStoredLabor} from "./laborBackfill";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",r="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const p={businessId:b,restaurantGuid:r,locationId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 timezone:"America/Los_Angeles",timeZone:"America/Los_Angeles"};
function makeDb(){
 let saved:string|null=null;
 const db={from(table:string){
  let ascending=true;
  const q={select(){return q;},eq(){return q;},order(_key:string,opts:{ascending:boolean}){
    ascending=opts.ascending;return q;},limit(){return q;},
   maybeSingle:async()=>({data:table==="toast_day_status"?
    {business_date:ascending?"2026-08-01":"2026-10-06"}:saved?{next_at:saved}:null,error:null}),
   upsert:async(data:{next_at:string})=>{saved=data.next_at;return {error:null};}};
  return q;
 }};
 return {db:db as never,get saved(){return saved;}};
}
it("67 recorded days are imported in 3 non-overlapping <=30-day chunks",async()=>{
 const f=makeDb(),ranges:Array<[number,number]>=[];
 const result=await backfillToastStoredLabor(f.db,p,Date.now()+60000,async(_db,_p,range)=>{
  ranges.push([range.since.getTime(),range.until.getTime()]);
 },3);
 expect(result.complete).toBe(true);
 expect(ranges).toHaveLength(3);
 expect(ranges.every(([a,b])=>b-a<=30*86400000)).toBe(true);
 expect(ranges[0][1]).toBe(ranges[1][0]);
 expect(ranges[1][1]).toBe(ranges[2][0]);
});
it("resumes after a timeout without duplicating the committed first chunk",async()=>{
 const f=makeDb(),visited:string[]=[];
 let attempt=0;
 await expect(backfillToastStoredLabor(f.db,p,Date.now()+60000,
 async(_db,_p,range)=>{
   attempt++;visited.push(range.since.toISOString());
   if(attempt===2)throw Error("timeout");
 },3)).rejects.toThrow("timeout");
 expect(f.saved).toBeTruthy();
 await backfillToastStoredLabor(f.db,p,Date.now()+60000,
 async(_db,_p,range)=>{visited.push(range.since.toISOString());},3);
 expect(visited).toHaveLength(4);
 expect(visited[1]).toBe(visited[2]);
 expect(visited[0]).not.toBe(visited[2]);
});
