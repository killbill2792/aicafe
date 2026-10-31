import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({
  existing: null as null|{id:string;media_type:string;bytes:number;original_name:string},
  upload:vi.fn(),download:vi.fn(),remove:vi.fn(),insert:vi.fn(),member:vi.fn(),
}));
const attachmentId="55555555-5555-4555-8555-555555555555";
vi.mock("@/lib/ai/conversations/authorizedTurn.server",()=>({
  authorizedExternalConversation:m.member,
  externalOwnerClientMessageId:()=>attachmentId,
}));
const pdf=new TextEncoder().encode("%PDF-1.7\nVerified test invoice");
vi.mock("@/lib/supabase/admin",()=>({
 createAdminSupabaseClient:()=>({
  from:()=>({
   select:()=>({
    eq(){
     return this;
    },
    maybeSingle:async()=>({data:m.existing,error:null}),
   }),
   insert:m.insert,
  }),
  storage:{from:()=>({upload:m.upload,download:m.download,remove:m.remove})},
 }),
}));
import {saveWhatsAppMediaDraft} from "./media.server";
const scope={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
const data={scope,threadId:"22222222-2222-4222-8222-222222222222",wamid:"wamid.HBgABA==",
 media:{bytes:pdf,mimeType:"application/pdf" as const,name:"invoice.pdf"}};
describe("durable private media recovery",()=>{
 beforeEach(()=>{
  vi.clearAllMocks();m.existing=null;
  m.upload.mockResolvedValue({error:null});
  m.download.mockResolvedValue({error:null,data:new Blob([pdf],{type:"application/pdf"})});
  m.remove.mockResolvedValue({error:null});
  m.insert.mockResolvedValue({error:null});
 });
 it("recovers an identical private orphan after interrupted upload without overwriting",async()=>{
  m.upload.mockResolvedValue({error:{message:"duplicate"}});
  const out=await saveWhatsAppMediaDraft(data);
  expect(out).toEqual({attachmentId,state:"stored_unanalysed"});
  expect(m.download).toHaveBeenCalledTimes(1);
  expect(m.insert).toHaveBeenCalledTimes(1);
  expect(m.remove).not.toHaveBeenCalled();
  expect(m.upload.mock.calls[0][2]).toMatchObject({upsert:false});
 });
 it("rejects a conflicting orphan instead of trusting another attachment",async()=>{
  m.upload.mockResolvedValue({error:{message:"duplicate"}});
  m.download.mockResolvedValue({error:null,data:new Blob([new TextEncoder().encode("%PDF-1.7\nWrong bytes")])});
  await expect(saveWhatsAppMediaDraft(data)).rejects.toThrow();
  expect(m.insert).not.toHaveBeenCalled();
  expect(m.remove).not.toHaveBeenCalled();
 });
 it("recognizes an already committed draft and writes neither file nor new row",async()=>{
  m.existing={id:attachmentId,media_type:"application/pdf",bytes:pdf.length,original_name:"invoice.pdf"};
  expect(await saveWhatsAppMediaDraft(data)).toEqual({attachmentId,state:"stored_unanalysed"});
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.insert).not.toHaveBeenCalled();
 });
 it("recognizes a matching row that another worker inserted during the race",async()=>{
  m.insert.mockImplementation(async()=>{
   m.existing={id:attachmentId,media_type:"application/pdf",bytes:pdf.length,original_name:"invoice.pdf"};
   return {error:{code:"23505"}};
  });
  expect(await saveWhatsAppMediaDraft(data)).toEqual({attachmentId,state:"stored_unanalysed"});
  expect(m.remove).not.toHaveBeenCalled();
 });
});
