import { describe,expect,it,vi } from "vitest";
import { classifyPendingTurns,type ClassifierStore } from "./questionPatterns.server";
const id=(n:number)=>"00000000-0000-0000-0000-"+String(n).padStart(12,"0");
describe("daily pattern classification",()=>{
  it("handles batches and persists only controlled topics, never raw questions",async()=>{
    const rows=Array.from({length:205},(_,i)=>({id:id(i),question:i%2?"Break even today?":"Payroll costs?"}));
    const saved:{id:string;topic:string}[]=[];
    const store:ClassifierStore={
      nextBatch:vi.fn(async(_version,limit)=>rows.splice(0,limit)),
      apply:vi.fn(async values=>{saved.push(...values);return values.length;}),
    };
    expect(await classifyPendingTurns(store)).toMatchObject({processed:205,remainingPossible:false});
    expect(saved.length).toBe(205);
    expect(JSON.stringify(saved)).not.toContain("Payroll costs?");
    expect(saved.every(row=>row.topic==="break_even"||row.topic==="labor")).toBe(true);
  });
  it("propagates database failure to cron, never silently claims success",async()=>{
    const store:ClassifierStore={
      nextBatch:async()=>[{id:id(1),question:"Sales?"}],
      apply:async()=>{throw new Error("db error");},
    };
    await expect(classifyPendingTurns(store)).rejects.toThrow("db error");
  });
});
