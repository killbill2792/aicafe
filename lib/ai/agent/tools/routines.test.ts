import {describe,it,expect,vi} from "vitest";
import {routineTools} from "./routines";
const ctx=(port:unknown)=>({routines:port}) as never;
const blank={routine_id:null,revision:null,title:null,cadence:null,weekdays:null,local_time:null,goal_source_message_id:null,source_page_offset:null};
describe("approve-first routine draft",()=>{
  it("saves nothing and returns a draft the owner must approve",async()=>{
    const create=vi.fn();
    const ids={ownerMessageId:"11111111-1111-4111-8111-111111111111",goalSourceMessageId:"22222222-2222-4222-8222-222222222222"};
    const draft=vi.fn(()=>ids);
    const res=await routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Meal break check",cadence:"daily",weekdays:[],local_time:"13:00",
    },ctx({create,draft,list:vi.fn(),change:vi.fn()}));
    expect(create).not.toHaveBeenCalled();
    expect(res).toMatchObject({draft:true,saved:false,missing:[],
      routineDraft:{title:"Meal break check",cadence:"daily",weekdays:[],localTime:"13:00",...ids}});
    expect(res.routine).toBeUndefined();
  });
});
describe("verified owner routine chat tool",()=>{
  it("saves only through server verified port",async()=>{
    const create=vi.fn(async(input)=>({id:"saved",...input}));
    const res=await routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Morning evidence",cadence:"daily",
      weekdays:[],local_time:"08:00",
    },ctx({create,list:vi.fn(),change:vi.fn()}));
    expect(create).toHaveBeenCalledWith({
      title:"Morning evidence",cadence:"daily",weekdays:[],localTime:"08:00"},null);
    expect(res.missing).toEqual([]);
  });
  it("lets Luna select the original authenticated goal after the owner clarifies time",async()=>{
    const original="22222222-2222-4222-8222-222222222222";
    const create=vi.fn(async()=>({id:"saved-original-goal"}));
    await routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Review sales and stock",cadence:"weekly",
      weekdays:[1],local_time:"09:00",goal_source_message_id:original,
    },ctx({create,list:vi.fn(),change:vi.fn()}));
    expect(create).toHaveBeenCalledWith({title:"Review sales and stock",
      cadence:"weekly",weekdays:[1],localTime:"09:00"},original);
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"create",title:"Review",cadence:"daily",weekdays:[],
      local_time:"09:00",goal_source_message_id:"fake-source",
    },ctx({create}))).rejects.toThrow();
  });
  it("lets Luna page older authenticated owner-goal candidates rather than silently saving a scheduling reply",async()=>{
    const original="22222222-2222-4222-8222-222222222222";
    const goalSources=vi.fn(async(offset:number)=>({
      sources:[{id:original,text:"Investigate weekly customer demand and inventory history."}],
      nextOffset:100,
    }));
    const response=await routineTools.manage_routine.execute({
      ...blank,action:"list_goal_sources",source_page_offset:50,
    },ctx({goalSources,list:vi.fn(),create:vi.fn(),change:vi.fn()}));
    expect(goalSources).toHaveBeenCalledWith(50);
    await routineTools.manage_routine.execute({
      ...blank,action:"list_goal_sources",source_page_offset:0,
    },ctx({goalSources}));
    expect(goalSources).toHaveBeenLastCalledWith(0);
    expect(response).toMatchObject({missing:[],next_offset:100,
      sources:[{id:original,text:"Investigate weekly customer demand and inventory history."}]});
  });
  it("refuses an unbound goal source page and oversized offsets",async()=>{
    const unbound=await routineTools.manage_routine.execute({
      ...blank,action:"list_goal_sources",source_page_offset:50,
    },ctx({list:vi.fn(),create:vi.fn(),change:vi.fn()}));
    expect(unbound.missing).toEqual(["not_supported"]);
    await expect(routineTools.manage_routine.execute({
      ...blank,action:"list_goal_sources",source_page_offset:10001,
    },ctx({goalSources:vi.fn()}))).rejects.toThrow();
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
