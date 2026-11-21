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
  it("edits an authenticated owner objective without requiring a replacement schedule",async()=>{
    const change=vi.fn(async(input)=>({id:input.id,revision:input.revision+1,
      objectiveUpdates:[{sourceMessageId:"authenticated-turn"}]}));
    const id="11111111-1111-4111-8111-111111111111";
    const saved=await routineTools.manage_routine.execute({
      ...blank,action:"edit_goal",routine_id:id,revision:4,
    },ctx({change,list:vi.fn()}));
    expect(change).toHaveBeenCalledWith({
      id,revision:4,objectiveEdit:true,
    });
    expect(saved.missing).toEqual([]);
    expect(saved.routine).toMatchObject({revision:5});
  });
  it("refuses incomplete combined goal/schedule updates instead of claiming success",async()=>{
    const change=vi.fn();
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"edit_goal",
      routine_id:"11111111-1111-4111-8111-111111111111",
      revision:2,title:"Renamed but no schedule supplied",
    },ctx({change}))).rejects.toThrow("partial changes cannot be silently ignored");
    expect(change).not.toHaveBeenCalled();
  });
  it("does not treat a schedule-only edit as a replacement goal",async()=>{
    const change=vi.fn(async input=>({id:input.id,revision:2}));
    const id="11111111-1111-4111-8111-111111111111";
    await routineTools.manage_routine.execute({
      ...blank,action:"edit",routine_id:id,revision:1,title:"Monday review",
      cadence:"weekly",weekdays:[1],local_time:"09:15",
    },ctx({change}));
    expect(change).toHaveBeenCalledWith({id,revision:1,
      schedule:{title:"Monday review",cadence:"weekly",weekdays:[1],localTime:"09:15"}});
  });
  it("rejects duplicate weekdays",async()=>{
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Weekly review",cadence:"weekly",
      weekdays:[2,2],local_time:"10:30",
    },ctx({create:vi.fn()}))).rejects.toThrow();
  });
});
