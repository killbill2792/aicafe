import {describe,it,expect} from "vitest";
import {verifyBearer} from "./bearer";
const req=(v?:string)=>new Request("https://example.test",{headers:v?{authorization:v}:{}});
describe("constant time cron authorization",()=>{
 it("accepts exactly the configured bearer",()=>expect(verifyBearer(req("Bearer correct"),"correct")).toBe(true));
 it("rejects missing configuration and header",()=>{
  expect(verifyBearer(req("Bearer correct"),undefined)).toBe(false);
  expect(verifyBearer(req("Bearer correct"),"")).toBe(false);
  expect(verifyBearer(req(),"correct")).toBe(false);
 });
 it("rejects malformed, incorrect and different-length values without throwing",()=>{
  for(const value of ["Basic correct","Bearer ","Bearer wrong","Bearer correct-extra","bearer correct"]){
   expect(verifyBearer(req(value),"correct")).toBe(false);
  }
 });
});
