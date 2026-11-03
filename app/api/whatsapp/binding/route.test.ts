import {beforeEach,describe,expect,it,vi} from "vitest";
const mock=vi.hoisted(()=>({scope:vi.fn(),server:vi.fn()}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  authenticatedConversationContext:mock.scope,
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mock.server}));
vi.mock("@/lib/ai/conversations/http.server",()=>({
  requireSameOrigin:(request:Request)=>{
    if(request.headers.get("origin")!=="https://app.test")
      throw Object.assign(new Error("invalid_origin"),{status:403});
  },
  readBoundedJson:(r:Request)=>r.json(),
  parseInput:(schema:{parse:(x:unknown)=>unknown},value:unknown)=>schema.parse(value),
  conversationJson:(value:unknown,status=200)=>Response.json(value,{status}),
  conversationError:(error:unknown)=>Response.json(
    {error:error instanceof Error?error.message:"unknown"},
    {status:typeof error==="object"&&error&&"status" in error?Number(error.status):503}),
}));
import {GET,POST,DELETE,connectInput} from "./route";

const business="f83ff25c-b593-4cf8-b2c1-5d5f3dd5f80e";
const owner="ec885ae5-a344-4d74-a73e-11dab3bf51c9";
const thread="61852cf0-95ee-4e33-871a-8a45de263709";
const phone="+19515574877";
let currentUser:Record<string,unknown>;
let threadRow:Record<string,unknown>|null;
let activeBindings:Array<Record<string,unknown>>;
const inserted=vi.fn(),updated=vi.fn();
const from=vi.fn((table:string)=>{
  const chain:Record<string,unknown>={};
  for(const method of ["select","eq","is"])chain[method]=()=>chain;
  chain.limit=async()=>({data:table==="whatsapp_owner_bindings"?activeBindings:[],error:null});
  chain.maybeSingle=async()=>({data:table==="ai_threads"?threadRow:null,error:null});
  chain.insert=inserted;
  chain.update=updated;
  return chain;
});
const db={auth:{getUser:vi.fn(async()=>({data:{user:currentUser},error:null}))},from};
const request=(body:unknown,origin="https://app.test")=>new Request(
  "https://app.test/api/whatsapp/binding",{
    method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify(body),
  });
beforeEach(()=>{
  currentUser={phone,phone_confirmed_at:"2026-11-01T01:00:00Z"};
  threadRow={id:thread};activeBindings=[];
  inserted.mockReset().mockResolvedValue({error:null});
  updated.mockReset().mockImplementation(()=>{const q:{eq:(key:string,value:unknown)=>unknown}={eq:()=>q};
    // Supabase's final chained update is thenable; resolve after all scope filters.
    (q as unknown as {then:unknown}).then=(resolve:(v:unknown)=>unknown)=>Promise.resolve({error:null}).then(resolve);
    return q;});
  from.mockClear();
  mock.server.mockClear().mockResolvedValue(db);
  mock.scope.mockClear();
  mock.scope.mockResolvedValue({scope:{businessId:business,ownerUserId:owner},
    service:{listThreads:async()=>({items:[{id:thread,title:"My café",createdAt:"2026-11-01",updatedAt:"2026-11-01",lastMessageAt:null}]})}});
});
describe("owner WhatsApp binding",()=>{
  it("requires explicit consent and valid thread",()=>{
    expect(connectInput.safeParse({threadId:thread,consent:true}).success).toBe(true);
    expect(connectInput.safeParse({threadId:thread,consent:false}).success).toBe(false);
    expect(connectInput.safeParse({threadId:"bad",consent:true}).success).toBe(false);
    expect(connectInput.safeParse({threadId:thread,consent:true,phone:"+15556667777"}).success).toBe(false);
  });
  it("refuses unconfirmed phone before reading or writing a binding",async()=>{
    currentUser={phone,phone_confirmed_at:null};
    const response=await POST(request({threadId:thread,consent:true}));
    expect(response.status).toBe(422);
    expect(from).not.toHaveBeenCalled();
    expect(inserted).not.toHaveBeenCalled();
  });
  it("rejects a different café or owner's conversation",async()=>{
    threadRow=null;
    const response=await POST(request({threadId:thread,consent:true}));
    expect(response.status).toBe(404);
    expect(inserted).not.toHaveBeenCalled();
  });
  it("rejects cross-site requests before accessing the owner account",async()=>{
    const response=await POST(request({threadId:thread,consent:true},"https://attacker.test"));
    expect(response.status).toBe(403);
    expect(mock.server).not.toHaveBeenCalled();
  });
  it("inserts only the verified auth phone and active owner/café scope",async()=>{
    const response=await POST(request({threadId:thread,consent:true}));
    expect(response.status).toBe(201);
    expect(inserted).toHaveBeenCalledOnce();
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({
      phone_number_id:"1322195347653883",wa_id:"19515574877",
      business_id:business,owner_user_id:owner,thread_id:thread,opted_in:true,
      verified_at:"2026-11-01T01:00:00Z",
    }));
  });
  it("never silently replaces an existing selected thread",async()=>{
    activeBindings=[{id:"already",thread_id:"another"}];
    expect((await POST(request({threadId:thread,consent:true}))).status).toBe(409);
    expect(inserted).not.toHaveBeenCalled();
  });
  it("returns scoped threads and verified phone, not an arbitrary WhatsApp sender",async()=>{
    const response=await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({verifiedPhone:phone,binding:null,
      businessId:business,threads:[{id:thread}]});
  });
  it("disconnects using the authenticated owner scope",async()=>{
    activeBindings=[{id:"existing"}];
    const response=await DELETE(new Request("https://app.test/api/whatsapp/binding",
      {method:"DELETE",headers:{origin:"https://app.test"}}));
    expect(response.status).toBe(200);
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({opted_in:false}));
  });
});
