import {describe,expect,it,vi} from "vitest";
import {openEventDayThread,eventOwnerMessage,eventContextFromTitle,eventThreadTitle,eventThreadKey} from "./eventDayThread";

describe("Chat about this event day",()=>{
  it("only creates and selects the day thread on explicit tap, with no automatic message",async()=>{
    const calls:string[]=[];
    const known=new Map<string,string>();
    const create=vi.fn(async(title:string)=>{calls.push("create "+title);return {id:"thread-for-31"};});
    const select=vi.fn((id:string)=>calls.push("select "+id));
    const args={date:"2026-10-31",title:"Halloween",known,create,select};
    expect(await openEventDayThread(args)).toBe("thread-for-31");
    expect(calls).toEqual(["create Events · 2026-10-31 · Halloween","select thread-for-31"]);
    expect(known.get(eventThreadKey("2026-10-31"))).toBe("thread-for-31");
    calls.length=0;
    expect(await openEventDayThread(args)).toBe("thread-for-31");
    expect(calls).toEqual(["select thread-for-31"]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("doesn't cache or select a new thread when creation is denied",async()=>{
    const known=new Map<string,string>(),select=vi.fn();
    await expect(openEventDayThread({date:"2026-11-01",title:"Festival",known,
      create:async()=>{throw new Error("owner_access_required");},select})).rejects.toThrow("owner_access_required");
    expect(known.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("event context is explicit and survives the owner's next message",()=>{
  const context={date:"2026-10-31",title:"Halloween",threadId:"thread-for-31"};
  it("anchors 'explain this' to the saved Halloween date, once, without JSON",()=>{
    const text="@event Halloween (2026-10-31)\nExplain this";
    expect(eventOwnerMessage("Explain this",context)).toBe(text);
    expect(eventOwnerMessage(text,context)).toBe(text);
    expect(eventOwnerMessage("Explain this",null)).toBe("Explain this");
    expect(eventOwnerMessage("",context)).toBe("");
  });
  it("restores event threads without misidentifying unrelated conversations",()=>{
    expect(eventContextFromTitle(eventThreadTitle(context.date,context.title),context.threadId)).toEqual(context);
    expect(eventContextFromTitle("Events · 2026-10-31",context.threadId)).toEqual({
      date:"2026-10-31",title:"Event",threadId:context.threadId,
    });
    expect(eventContextFromTitle("Break-even analysis",context.threadId)).toBeNull();
    expect(eventContextFromTitle("Events · not-a-day · Halloween",context.threadId)).toBeNull();
  });
});

describe("multiple events on the same calendar date",()=>{
  const date="2026-10-31";
  const firstId="11111111-1111-4111-8111-111111111111";
  const secondId="22222222-2222-4222-8222-222222222222";
  it("creates and reuses distinct event conversations, never the same date cache",async()=>{
    const known=new Map<string,string>();
    const create=vi.fn(async(title:string)=>({id:title.includes(firstId)?"thread-a":"thread-b"}));
    const select=vi.fn();
    const base={date,title:"Halloween",known,create,select};
    const first=await openEventDayThread({...base,eventId:firstId});
    const second=await openEventDayThread({...base,eventId:secondId});
    expect(first).toBe("thread-a");
    expect(second).toBe("thread-b");
    expect(known.get(eventThreadKey(date,firstId))).toBe(first);
    expect(known.get(eventThreadKey(date,secondId))).toBe(second);
    expect(await openEventDayThread({...base,eventId:firstId})).toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
    expect(select.mock.calls.map(call=>call[0])).toEqual(["thread-a","thread-b","thread-a"]);
  });
  it("restores exact saved event identity from thread title, even for equal names",()=>{
    const title=eventThreadTitle(date,"Halloween",secondId);
    expect(eventContextFromTitle(title,"thread-b")).toEqual({
      date,title:"Halloween",eventId:secondId,threadId:"thread-b",
    });
    expect(eventOwnerMessage("Explain this",{
      date,title:"Halloween",eventId:secondId,threadId:"thread-b",
    })).toBe("@event Halloween (2026-10-31) [id:"+secondId+"]\nExplain this");
    expect(eventThreadTitle(date,"x".repeat(200),secondId).length).toBeLessThanOrEqual(120);
    expect(eventContextFromTitle("Events · 2026-10-31 · Halloween","old"))
      .toEqual({date,title:"Halloween",threadId:"old"});
  });
  it("keeps the day report separate from event-specific threads",async()=>{
    const known=new Map<string,string>([[eventThreadKey(date,firstId),"event-thread"]]);
    const create=vi.fn(async()=>({id:"day-thread"}));
    const day=await openEventDayThread({date,title:"Halloween outlook",known,create,select:vi.fn()});
    expect(day).toBe("day-thread");
    expect(known.get(eventThreadKey(date,firstId))).toBe("event-thread");
    expect(known.get(eventThreadKey(date))).toBe("day-thread");
  });
});
