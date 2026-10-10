import {describe,it,expect} from "vitest";
import {attachmentInput,safeFileName,verifySignature,MAX_BYTES} from "./attachments";
describe("Phase 6 owner attachment validation",()=>{
 it("rejects unsupported formats, oversized files and spoofed claims",()=>{
  expect(attachmentInput.safeParse({filename:"bill.pdf",mimeType:"application/pdf",bytes:150}).success).toBe(true);
  expect(attachmentInput.safeParse({filename:"bill.html",mimeType:"text/html",bytes:150}).success).toBe(false);
  expect(attachmentInput.safeParse({filename:"bill.pdf",mimeType:"application/pdf",bytes:MAX_BYTES+1}).success).toBe(false);
  expect(attachmentInput.safeParse({filename:"bill.pdf",mimeType:"application/pdf",bytes:150,role:"supervisor"}).success).toBe(false);
 });
 it("rejects fake PDF, script masquerading as text and binary",()=>{
  const enc=new TextEncoder();
  expect(verifySignature("application/pdf",enc.encode("%PDF-1.7 bill"))).toBe(true);
  expect(verifySignature("application/pdf",enc.encode("invoice data"))).toBe(false);
  expect(verifySignature("text/plain",enc.encode("<html>fake</html>"))).toBe(false);
  expect(verifySignature("text/plain",new Uint8Array([0,12]))).toBe(false);
  expect(verifySignature("image/png",new Uint8Array([137,80,78,71,13,10,26,10,1]))).toBe(true);
 });
 it("strips traversal and punctuation from filenames",()=>{
  expect(safeFileName("../../unsafe <script>.pdf")).not.toContain("/");
  expect(safeFileName("bill.pdf")).toBe("bill.pdf");
 });
});
