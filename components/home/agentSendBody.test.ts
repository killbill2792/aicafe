import {describe,it,expect} from "vitest";
import {buildAgentSendBody} from "./agentSendBody";
describe("idle chat receipt attachments",()=>{
 it("includes selected images only, maximum three",()=>{
  expect(buildAgentSendBody("key","receipt","en",[{id:"a",mediaType:"image/jpeg"},{id:"pdf",mediaType:"application/pdf"},{id:"b",mediaType:"image/png"},{id:"c",mediaType:"image/webp"},{id:"d",mediaType:"image/jpeg"}]).attachmentIds).toEqual(["a","b","c"]);
 });
});