import {describe,it,expect,vi} from "vitest";
import {routineTools} from "./routines";
const ctx=(port:unknown)=>({routines:port}) as never;
const blank={routine_id:null,revision:null,title:null,cadence:null,weekdays:null,local_time:null};
describe("verified owner routine chat tool",()=>{
  it("saves only through server verified port",async()=>{
    const create=vi.fn(async(input)=>({id:"saved",...input}));
    const res=await routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Morning evidence",cadence:"daily",
      weekdays:[],local_time:"08:00",
    },ctx({create,list:vi.fn(),change:vi.fn()}));
    expect(create).toHaveBeenCalledWith({
      title:"Morning evidence",cadence:"daily",weekdays:[],localTime:"08:00"});
    expect(res.missing).toEqual([]);
  });
  it("does not pretend success if no authenticated port exists",async()=>{
    const res=await routineTools.manage_routine.execute({...blank,action:"list"},ctx(undefined));
    expect(res.missing).toEqual(["not_supported"]);
  });
  it("rejects invented routine ID or missing CAS revision",async()=>{
    const change=vi.fn();
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"pause",routine_id:null,revision:1,
    },ctx({change}))).rejects.toThrow();
    expect(change).not.toHaveBeenCalled();
  });
  it("rejects duplicate weekdays",async()=>{
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Weekly review",cadence:"weekly",
      weekdays:[2,2],local_time:"10:30",
    },ctx({create:vi.fn()}))).rejects.toThrow();
  });
});
