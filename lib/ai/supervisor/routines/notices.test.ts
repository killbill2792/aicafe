import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const notices=vi.hoisted(()=>({gateway:vi.fn()}));
vi.mock("@/lib/operating/notifyOwner.server",()=>({notifyOwner:notices.gateway}));
import {postPriorityNotice} from "./notices.server";
import {choosePriorities} from "./priority";
const scope={businessId:"cafe",ownerUserId:"owner",threadId:"thread",localDate:"2026-11-11"};
const [decision]=choosePriorities([{
  businessId:"cafe",ownerUserId:"owner",sourceType:"alert",sourceId:"a",
  status:"new",kind:"voids",createdAt:"2026-11-11T00:00:00Z",
}],new Date("2026-11-11T01:00:00Z"));
describe("priority notice gateway",()=>{
  it("delegates to one existing owner notice gateway and records a scoped receipt",async()=>{
    notices.gateway.mockImplementation(async(_db,_req,write)=>({
      decision:"posted",result:await write(),channels:{inApp:"posted",whatsapp:"not_delivered"},
    }));
    const rpc=vi.fn(async()=>({data:true,error:null}));
    expect(await postPriorityNotice({rpc} as never,scope,decision,new Date("2026-11-11T01:00:00Z")))
      .toBe("posted");
    expect(rpc).toHaveBeenCalledWith("post_supervisor_priority_notice",
      expect.objectContaining({p_business_id:"cafe",p_owner_user_id:"owner",p_source_id:"a"}));
  });
  it("rejects cross-owner decisions before accessing a privileged client",async()=>{
    const rpc=vi.fn();
    await expect(postPriorityNotice({rpc} as never,scope,
      {...decision,source:{...decision.source,ownerUserId:"other"}},
      new Date())).rejects.toThrow("Notice scope mismatch");
    expect(rpc).not.toHaveBeenCalled();
  });
});
