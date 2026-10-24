import { describe,expect,it,vi } from "vitest";
const access=vi.hoisted(()=>({allowed:true}));
vi.mock("@/lib/access/access.server",()=>({
  assertCafeAiAccess:async()=>{
    if(!access.allowed){
      const {ConversationApiError}=await import("@/lib/ai/conversations/auth.server");
      throw new ConversationApiError(403,"access_expired");
    }
  },
}));
import { POST } from "./route";
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  authenticatedConversationContext:async()=>({scope:{
    businessId:"11111111-1111-4111-8111-111111111111",
    ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }}),
  ConversationApiError:class ConversationApiError extends Error {
    constructor(public status:number,public code:string){super(code);}
  },
}));
vi.mock("@/lib/data/initiatives.server",()=>({
  activateOwnerInitiative:vi.fn(async()=>({revision:2,status:"active"})),
}));
const id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const url="https://example.com/api/ai/initiatives/"+id+"/approve";
const context={params:Promise.resolve({id})};
describe("initiative approval",()=>{
  it("does not apply approvals after access expiry",async()=>{
    access.allowed=false;
    try{
      const response=await POST(new Request(url,{method:"POST",
        headers:{"content-type":"application/json",origin:"https://example.com"},
        body:JSON.stringify({revision:1})}),context);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({error:"access_expired"});
    }finally{access.allowed=true;}
  });
  it("rejects cross-origin and missing Origin",async()=>{
    for(const origin of [null,"https://evil.example"]){
      const headers:Record<string,string>={"content-type":"application/json"};
      if(origin)headers.origin=origin;
      expect((await POST(new Request(url,{method:"POST",headers,body:JSON.stringify({revision:1})}),context)).status).toBe(403);
    }
  });
  it("uses revision and owner-authenticated route for a proposal",async()=>{
    const response=await POST(new Request(url,{method:"POST",
      headers:{"content-type":"application/json",origin:"https://example.com"},
      body:JSON.stringify({revision:1})}),context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({id,status:"active",revision:2});
  });
  it("rejects invalid revision payload",async()=>{
    const response=await POST(new Request(url,{method:"POST",
      headers:{"content-type":"application/json",origin:"https://example.com"},
      body:JSON.stringify({revision:0})}),context);
    expect(response.status).toBe(422);
  });
});
