import {describe,expect,it} from "vitest";
import {describeFinding,parseFindings,planBytes} from "./dataHealth";

const name=(id:string)=>id==="b1"?"Seiyun":"Unknown café";
describe("data health findings",()=>{
  it("says each problem in plain words with its numbers",()=>{
    expect(describeFinding({kind:"database_near_limit",database_bytes:6*1024**3,plan_bytes:8*1024**3},name))
      .toBe("Database is 6,144 MB, over 70% of the 8,192 MB plan.");
    expect(describeFinding({kind:"sudden_growth",database_bytes:400*1024**2,previous_bytes:270*1024**2},name))
      .toBe("Database grew from 270 MB to 400 MB since the last check.");
    expect(describeFinding({kind:"repeated_pos_records",business_id:"b1",entity:"void",objects:120,extra_rows:130},name))
      .toBe("Seiyun: 120 Toast void records stored more than once on the same day (130 extra rows).");
    expect(describeFinding({kind:"total_mismatch",business_id:"b1",business_date:"2026-11-02",
      import_net_cents:150000,stored_net_cents:149500,toast_net_cents:null},name))
      .toBe("Seiyun 2026-11-02: stored orders 1495.00, import total 1500.00, Toast total none.");
  });
  it("counts unknown finding shapes instead of guessing",()=>{
    const r=parseFindings([{kind:"sudden_growth",database_bytes:1,previous_bytes:0},{kind:"new_kind"},null]);
    expect(r.known).toHaveLength(1);
    expect(r.unknown).toBe(2);
    expect(parseFindings("nope")).toEqual({known:[],unknown:0});
  });
  it("uses the configured plan size, else 8 GB",()=>{
    expect(planBytes("1073741824")).toBe(1073741824);
    expect(planBytes(undefined)).toBe(8*1024**3);
    expect(planBytes("abc")).toBe(8*1024**3);
    expect(planBytes("-5")).toBe(8*1024**3);
  });
});
