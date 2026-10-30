import {describe,expect,it,vi} from "vitest";
import {openEventDayThread} from "./eventDayThread";
import {buildAgentSendBody} from "./agentSendBody";

describe("Chat about this event day",()=>{
  it("creates and selects a dedicated thread, sending the selected day's facts there",async()=>{
    const calls:string[]=[];
    const known=new Map<string,string>();
    const create=vi.fn(async(title:string)=>{calls.push("create "+title);return {id:"thread-for-31"};});
    const select=vi.fn((id:string)=>calls.push("select "+id));
    const priorThreadAttachments=[{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",mediaType:"image/jpeg"}];
    const send=vi.fn(async(prompt:string,id:string,files:readonly [])=>{
      calls.push("send "+id+" "+prompt);expect(files).toEqual([]);
      expect(priorThreadAttachments).toHaveLength(1); // state has not rerendered yet
      expect(buildAgentSendBody("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",prompt,"en",files))
        .toMatchObject({attachmentIds:[]});
    });
    const args={date:"2026-10-31",title:"Halloween",prompt:"Event context: Halloween",
      known,create,select,send};
    expect(await openEventDayThread(args)).toBe("thread-for-31");
    expect(calls).toEqual(["create Halloween","select thread-for-31","send thread-for-31 Event context: Halloween"]);
    expect(known.get("2026-10-31")).toBe("thread-for-31");
    calls.length=0;
    expect(await openEventDayThread(args)).toBe("thread-for-31");
    expect(calls).toEqual(["select thread-for-31"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Event context: Halloween","thread-for-31",[]);
  });

  it("doesn't cache or select a new thread when creation is denied",async()=>{
    const known=new Map<string,string>(),select=vi.fn(),send=vi.fn();
    await expect(openEventDayThread({date:"2026-11-01",title:"Festival",prompt:"festival",known,
      create:async()=>{throw new Error("owner_access_required");},select,send})).rejects.toThrow("owner_access_required");
    expect(known.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
