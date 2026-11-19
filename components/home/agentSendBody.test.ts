import {describe,it,expect} from "vitest";
import {buildAgentSendBody} from "./agentSendBody";
describe("idle chat receipt attachments",()=>{
 it("includes chosen images and documents, maximum three",()=>{
  expect(buildAgentSendBody("key","receipt","en",[{id:"a",mediaType:"image/jpeg"},{id:"pdf",mediaType:"application/pdf"},{id:"b",mediaType:"image/png"},{id:"c",mediaType:"image/webp"},{id:"d",mediaType:"image/jpeg"}]).attachmentIds).toEqual(["a","pdf","b"]);
 });
});
it("binds a clarification to its saved question without reattaching unrelated files",()=>{const response={questionId:"question",action:"supply" as const};expect(buildAgentSendBody("key","Tomorrow","en",[{id:"a",mediaType:"image/jpeg"}],response)).toEqual({clientMessageId:"key",text:"Tomorrow",locale:"en",attachmentIds:[],ownerInputResponse:response});});
