import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {lastSalesImportAt} from "./lastSalesImport.server";
it("menu-only run cannot change the last successful sales import",async()=>{
 const calls:Array<[string,unknown]>=[],timestamp="2026-10-26T15:00:00Z";
 const q={select:()=>q,eq:(k:string,v:unknown)=>{calls.push([k,v]);return q;},
  not:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:{imported_at:timestamp},error:null})};
 const db={from:(table:string)=>{expect(table).toBe("toast_day_status");return q;}} as never;
 expect(await lastSalesImportAt(db,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(timestamp);
 expect(calls).toContainEqual(["import_state","imported"]);
 expect(calls).not.toContainEqual(["kind","menu"]);
});
it("missing confirmed sales imports return unknown, not today",async()=>{
 const q={select:()=>q,eq:()=>q,not:()=>q,order:()=>q,limit:()=>q,
  maybeSingle:async()=>({data:null,error:null})};
 expect(await lastSalesImportAt({from:()=>q} as never,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeNull();
});
