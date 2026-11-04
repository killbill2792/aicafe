import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {readOwnerPriceMonitorProposals,readOwnerPriceMonitorReports} from "./reads.server";

type Db=Parameters<typeof readOwnerPriceMonitorProposals>[0];

describe("canonical price monitor proposal read",()=>{
  it("filters by owner, price capability and monitoring status before paginating",async()=>{
    const price="alex.menu_price_change.v1";
    const other="leo.goal.v1";
    const rows=[
      ...Array.from({length:205},(_,i)=>({id:`p-${i}`,business_id:"cafe-1",owner_user_id:"owner-1",
        capability_id:price,status:"committed",created_at:`2026-11-${String(i%28+1).padStart(2,"0")}`})),
      ...Array.from({length:300},(_,i)=>({id:`other-${i}`,business_id:"cafe-1",
        owner_user_id:"owner-1",capability_id:other,status:"committed",created_at:"2026-11-30"})),
      {id:"wrong-owner",business_id:"cafe-1",owner_user_id:"owner-2",
        capability_id:price,status:"committed",created_at:"2026-11-30"},
      {id:"wrong-status",business_id:"cafe-1",owner_user_id:"owner-1",
        capability_id:price,status:"declined",created_at:"2026-11-30"},
    ];
    const pages:number[]=[];
    const db={from:()=>{
      const filters:Array<(r:typeof rows[number])=>boolean>=[];
      const query={
        select:()=>query,
        eq:(field:string,value:string)=>{filters.push(r=>r[field as keyof typeof r]===value);return query;},
        in:(field:string,values:string[])=>{filters.push(r=>values.includes(r[field as keyof typeof r]));return query;},
        order:()=>query,
        range:async(start:number,end:number)=>{
          pages.push(start);
          return {data:rows.filter(r=>filters.every(f=>f(r))).sort((a,b)=>b.created_at.localeCompare(a.created_at))
            .slice(start,end+1),error:null};
        }
      };
      return query;
    }} as unknown as Db;
    const result=await readOwnerPriceMonitorProposals(db,{businessId:"cafe-1",ownerUserId:"owner-1"},
      [price,"alex.drink_price_experiment.v1"],["manual_confirmed","committed","monitored"]);
    expect(result).toHaveLength(205);
    expect(new Set(result.map(r=>r.id)).size).toBe(205);
    expect(result.some(r=>r.id==="p-0")).toBe(true);
    expect(result.some(r=>r.id==="p-204")).toBe(true);
    expect(pages).toEqual([0,100,200]);
  });
  it("reads all final reports across owner proposal batches without a 100-row cap",async()=>{
    const ids=Array.from({length:205},(_,i)=>`p-${i}`);
    const reports=[
      ...ids.map((proposal_id,i)=>({proposal_id,business_id:"cafe-1",status:"complete",
        generated_at:`2026-11-${String(i%28+1).padStart(2,"0")}`,
        report:{recommendation:"keep",coveredDays:7}})),
      ...ids.map(proposal_id=>({proposal_id,business_id:"cafe-1",status:"in_progress",
        generated_at:"2026-11-30",report:{recommendation:"adjust",coveredDays:3}})),
      {proposal_id:"foreign",business_id:"cafe-2",status:"complete",
        generated_at:"2026-11-30",report:{recommendation:"revert",coveredDays:7}},
    ];
    const queriedRanges:Array<{start:number;end:number;ids:string[];statuses:string[]}>= [];
    const db={from:()=>{
      const filters:Array<(r:typeof reports[number])=>boolean>=[];
      let selectedIds:string[]=[];
      let selectedStatuses:string[]=[];
      const query={
        select:()=>query,
        eq:(field:string,value:string)=>{filters.push(r=>r[field as keyof typeof r]===value);return query;},
        in:(field:string,values:string[])=>{
          if(field==="proposal_id")selectedIds=values;
          if(field==="status")selectedStatuses=values;
          filters.push(r=>values.includes(r[field as keyof typeof r] as string));return query;
        },
        order:()=>query,
        range:async(start:number,end:number)=>{
          queriedRanges.push({start,end,ids:[...selectedIds],statuses:[...selectedStatuses]});
          return {data:reports.filter(r=>filters.every(f=>f(r)))
            .sort((a,b)=>b.generated_at.localeCompare(a.generated_at)||b.proposal_id.localeCompare(a.proposal_id))
            .slice(start,end+1),error:null};
        }
      };
      return query;
    }} as unknown as Db;
    const result=await readOwnerPriceMonitorReports(db,{businessId:"cafe-1",ownerUserId:"owner-1"},
      ids,["complete","insufficient_evidence"]);
    expect(result).toHaveLength(205);
    expect(new Set(result.map(r=>r.proposal_id)).size).toBe(205);
    expect(result.every(r=>r.status==="complete")).toBe(true);
    expect(result.some(r=>r.proposal_id==="p-204")).toBe(true);
    expect(queriedRanges.some(r=>r.start===100)).toBe(true);
    expect(queriedRanges.every(r=>r.ids.length<=100&&r.statuses.join(",")==="complete,insufficient_evidence")).toBe(true);
  });
});
