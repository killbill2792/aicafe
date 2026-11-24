import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("./u3SqlResearch.server",()=>({
  u3SqlConfigured:()=>true,
  describeU3Catalog:vi.fn(async()=>{throw new Error("private transport details must not escape");}),
  runU3Sql:vi.fn()
}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({
  readToastDayTrust:vi.fn(async()=>({blocked:new Set(),quality:[],notes:[]}))
}));
import {dataQueryTools} from "./dataQuery";

describe("optional SQL catalog failures",()=>{
  it("surfaces the failure on the primary discovery status, without raw diagnostics",async()=>{
    const data=await dataQueryTools.describe_data.execute(
      {source:"auto",search:"sales"},
      {businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
       ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
       threadId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
       db:{} as never});
    expect(data.source).toBe("canonical_dictionary");
    expect(data.views.length).toBeGreaterThan(0);
    expect(data.missing).toContain("source_read_failed");
    expect(data.error).toBe("source_read_failed");
    expect(data.research).toMatchObject({missing:["source_read_failed"]});
    expect(JSON.stringify(data)).not.toContain("private transport details");
  });
});
