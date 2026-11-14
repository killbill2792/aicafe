import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import GmailConnectionPanel from "./GmailConnectionPanel";
import en from "@/messages/en.json";
describe("the one-click Gmail connect experience",()=>{
 it("initially checks the real provider status instead of pretending connected",()=>{
   const html=renderToStaticMarkup(createElement(GmailConnectionPanel));
   expect(html).toContain(en.GmailConnect.mailboxTitle);
   expect(html).toContain(en.GmailConnect.loading);
   expect(html).not.toContain(en.GmailConnect.connected);
   expect(html).not.toContain("access_token");
   expect(html).not.toContain("client_secret");
 });
 it("is clear about Google consent, owner approval and revocation",()=>{
   expect(en.GmailConnect.googleConsent).toContain("No API keys or passwords");
   expect(en.GmailConnect.ownerApproves).toContain("approval");
   expect(en.GmailConnect.revokePending).toContain("access is blocked");
   expect(en.GmailConnect.disconnectHint).toContain("never deletes");
 });
});
