import {createHash} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {chooseMetaMediaName,downloadWhatsAppMedia,verifiedMetaMediaUrl,verifyMetaMediaContent} from "./media.server";
const pdf=new TextEncoder().encode("%PDF-1.7\nexample");
const sha=createHash("sha256").update(pdf).digest("hex");

describe("private WhatsApp media acceptance",()=>{
 it("accepts only a vetted HTTPS Meta media host and path",()=>{
  expect(verifiedMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/a").hostname).toBe("lookaside.fbsbx.com");
  for(const url of [
   "http://lookaside.fbsbx.com/whatsapp_business/attachments/a",
   "https://lookaside.fbsbx.com.evil.com/whatsapp_business/attachments/a",
   "https://user:pass@lookaside.fbsbx.com/whatsapp_business/attachments/a",
   "https://127.0.0.1/whatsapp_business/attachments/a",
   "https://lookaside.fbsbx.com/elsewhere",
  ])expect(()=>verifiedMetaMediaUrl(url)).toThrow();
 });
 it("checks content signatures, SHA256 and media extension",()=>{
  expect(verifyMetaMediaContent("application/pdf",pdf,sha)).toBe(true);
  expect(verifyMetaMediaContent("image/jpeg",pdf,sha)).toBe(false);
  expect(verifyMetaMediaContent("application/pdf",pdf,"a".repeat(64))).toBe(false);
  expect(chooseMetaMediaName("invoice.pdf","application/pdf")).toBe("invoice.pdf");
  expect(()=>chooseMetaMediaName("malware.exe","application/pdf")).toThrow();
 });
 it("downloads a signed PDF as unanalysed private-draft input without extracting invoices",async()=>{
  const fetcher=vi.fn(async(url:string|URL)=>{
   if(String(url).startsWith("https://graph.facebook.com/"))
    return Response.json({url:"https://lookaside.fbsbx.com/whatsapp_business/attachments/123",
      mime_type:"application/pdf",file_size:pdf.length,sha256:sha});
   return new Response(pdf,{status:200,headers:{"content-type":"application/pdf",
     "content-length":String(pdf.length)}});
  });
  const media=await downloadWhatsAppMedia({mediaId:"12345",mimeType:"application/pdf",fileName:"invoice.pdf"},
    "test-private-token",fetcher as unknown as typeof fetch);
  expect(media.name).toBe("invoice.pdf");
  expect(media.bytes).toEqual(pdf);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe("https://graph.facebook.com/v21.0/12345");
 });
 it("uses Graph-certified PDF MIME from signed document kind, not a guessed webhook MIME",async()=>{
   const fetcher=vi.fn(async(url:string|URL)=>{
     if(String(url).startsWith("https://graph.facebook.com/"))
       return Response.json({url:"https://lookaside.fbsbx.com/whatsapp_business/attachments/123",
         mime_type:"application/pdf",file_size:pdf.length,sha256:sha});
     return new Response(pdf,{headers:{"content-type":"application/pdf",
       "content-length":String(pdf.length)}});
   });
   const result=await downloadWhatsAppMedia({mediaId:"12345",kind:"document"},
     "token",fetcher as unknown as typeof fetch);
   expect(result).toMatchObject({mimeType:"application/pdf",name:"attachment.pdf"});
   expect(result.bytes).toEqual(pdf);
   await expect(downloadWhatsAppMedia({mediaId:"12345",kind:"image"},
     "token",fetcher as unknown as typeof fetch)).rejects.toThrow("unsupported_whatsapp_media");
 });
 it("rejects wrong MIME or oversize Graph file before the bearer download",async()=>{
  const fetcher=vi.fn(async()=>Response.json({url:"https://lookaside.fbsbx.com/whatsapp_business/attachments/123",
     mime_type:"application/pdf",file_size:2097153,sha256:sha}));
  await expect(downloadWhatsAppMedia({mediaId:"123",mimeType:"application/pdf"},
    "test-private-token",fetcher as unknown as typeof fetch)).rejects.toThrow("unsupported_whatsapp_media");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(downloadWhatsAppMedia({mediaId:"123",mimeType:"application/zip"},
    "test-private-token",fetcher as unknown as typeof fetch)).rejects.toThrow("unsupported_whatsapp_media");
 });
});
