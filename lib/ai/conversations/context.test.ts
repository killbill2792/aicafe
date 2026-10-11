import { describe,expect,it } from "vitest";
import type { ConversationMessage } from "./contracts";
import { compactConversationContext } from "./context";
const make=(role:"owner"|"supervisor",id:string,blocks:unknown[]|null,text:string|null):ConversationMessage=>({
  id,threadId:"thread",role,contentType:role==="owner"?"text":"blocks",
  text,blocks,grounding:{businessId:"secret"},createdAt:"2026-10-10T10:00:00Z",clientMessageId:null,
});
describe("Bilateral bounded Supervisor conversation history",()=>{
  it("keeps prior human and rendered Supervisor replies for semantic follow-ups",()=>{
    const r=compactConversationContext([
      make("owner","one",null,"What are the top three?"),
      make("supervisor","two",[
        {type:"count",label:"Iced Latte units sold",value:15},
        {type:"count",label:"Mocha units sold",value:11},
        {type:"count",label:"Muffin units sold",value:7},
        {type:"task_card",agent:"olivia",title:"Coverage",status:"watching",taskId:"private"},
      ],null),
      make("owner","three",null,"What about the second one?"),
    ],"three");
    expect(r).toHaveLength(2);
    expect(r[1].text).toContain("Mocha units sold: 11");
    expect(r[1].text).not.toContain("private");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
