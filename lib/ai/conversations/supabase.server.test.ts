import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {SupabaseConversationRepository} from "./supabase.server";
import {PAGE_SIZE} from "./contracts";

describe("Supervisor conversations vs owner attention",()=>{
 it("excludes old generic system notices before pagination without losing owner turns",async()=>{
  const log:string[]=[];
  const builder={
   select:vi.fn(()=>builder),eq:vi.fn(()=>builder),
   or:vi.fn((expr:string)=>{log.push(expr);return builder;}),
   order:vi.fn(()=>builder),
   range:vi.fn(async()=>({data:[],error:null}))
  };
  const client={from:vi.fn(()=>builder)} as never;
  const repo=new SupabaseConversationRepository(client);
  const page=await repo.listMessages({
   businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
   ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  },"cccccccc-cccc-4ccc-8ccc-cccccccccccc",0);
  expect(page).toEqual({items:[],nextOffset:null});
  expect(log).toEqual([
   "grounding.is.null,grounding->>intent.is.null,grounding->>intent.not.in.(priority_notice,priority_investigation_exception)"
  ]);
  expect(builder.eq).toHaveBeenCalledWith("business_id","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(builder.eq).toHaveBeenCalledWith("owner_user_id","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  expect(builder.range).toHaveBeenCalledWith(0,PAGE_SIZE);
 });
});
