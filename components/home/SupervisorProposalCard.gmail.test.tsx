import {describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
vi.mock("server-only",()=>({}));
import {GmailApprovalDetails} from "./SupervisorProposalCard";
const effect={
  operation:"send",action:null,from:"owner@example.com",
  to:["supplier@example.org"],cc:["partner@example.org"],bcc:["audit@example.org"],
  subject:"November bean order",body:"Approve delivery of 24 bags by Friday.",
  messageId:null,threadId:null,labelId:null,labelName:null
};
describe("Gmail review includes the exact irreversible action details",()=>{
 it("shows From/To/Cc/Bcc, subject and body before approval",()=>{
   const html=renderToStaticMarkup(createElement(GmailApprovalDetails,{effect}));
   for(const item of ["owner@example.com","supplier@example.org",
     "partner@example.org","audit@example.org","November bean order",
     "Approve delivery of 24 bags by Friday."])
     expect(html).toContain(item);
   expect(html).not.toContain("access_token");
   expect(html).not.toContain("refresh_token");
 });
 it("shows precisely which provider message and label a modify effect targets",()=>{
   const html=renderToStaticMarkup(createElement(GmailApprovalDetails,{effect:{
     ...effect,operation:"modify",action:"add_label",messageId:"message-12345",
     labelId:"Label_230",labelName:"Supplier order"}}));
   expect(html).toContain("add label");
   expect(html).toContain("message-12345");
   expect(html).toContain("Label_230");
   expect(html).not.toContain("Approve delivery of 24 bags");
 });
});
