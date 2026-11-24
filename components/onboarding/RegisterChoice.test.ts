import {createElement, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";

// Use a regular anchor to inspect hrefs; production still uses the app's
// locale-aware Link component, so mobile and desktop share the same navigation.
vi.mock("@/i18n/navigation",()=>({
 Link:({href,children,className}:{
  href:string;children:ReactNode;className?:string
 })=>createElement("a",{href,className},children)
}));

vi.mock("next-intl",()=>({useLocale:()=> "en",useTranslations:()=> (key:string)=>key}));
vi.mock("next-intl/server",()=>({getTranslations:async()=> (key:string)=>key}));
import RegisterChoice from "./RegisterChoice";
import ToastConnectionForm from "@/components/more/ToastConnectionForm";

const labels={
 useToast:"Connect Toast",unavailable:"Toast setup is unavailable"
};
const connectionLabels={
 notEnabled:"Toast setup is currently unavailable",
 notConnected:"Not connected",
 configured:"Configured",verified:"Verified",
 missingPermissions:"Missing permissions",needsReconnect:"Needs reconnect",
 lastSyncFailed:"Last sync failed",stale:"Stale",url:"API URL",
 clientId:"Client ID",clientSecret:"Client Secret",locations:"Locations",
 restaurantGuid:"Restaurant GUID",save:"Save",test:"Test Connection",
 disconnect:"Disconnect",lastVerified:"Last verified",error:"Error",
 saved:"Saved",success:"Success",pending:"Saving",
 disconnectConfirm:"Disconnect?",noLocations:"No locations",
 instructions:"Connect your Toast register securely",
 retryAfter:"Retry after",lastSync:"Last sync",
 errorAuthentication:"Invalid credentials",
 errorMissingPermissions:"Missing permissions",
 errorUnauthorizedLocation:"Unauthorized restaurant",
 errorTimeout:"Timeout",errorRateLimited:"Too many requests",
 errorUnavailable:"Unavailable",errorInvalidResponse:"Invalid response",
 needsAttention:"Needs attention",fix:"Fix",technicalDetails:"Technical details",
 connectedLastSync:"Connected ✓ last sync {time}",noSyncYet:"not yet synced",
 manualLocationHint:"Add your authorized restaurant GUID under Technical details",
 chooseApiUrl:"Choose API URL under Technical details"
};

function choice(toastEnabled=true){
 return renderToStaticMarkup(createElement(RegisterChoice,{toastEnabled,labels}));
}
function anchorFor(markup:string,text:string){
 const matches=[...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
 return matches.find(([, ,content])=>content.includes(text));
}

describe("Toast-first private-café onboarding",()=>{
 it("offers only the owner-connected Toast setup",()=>{
  const html=choice();
  expect(anchorFor(html,"Connect Toast")?.[1]).toContain('href="/more/toast"');
  expect(html).not.toContain("Use Clover");
  expect(html).not.toContain("Connect Square");
  expect(html).not.toContain('href="/more/uploads"');
  expect(html).not.toContain("Skip");
  expect(html).not.toContain("Demo");
 });
 it("does not send owner to a broken Toast link if disabled",()=>{
  const html=choice(false);
  expect(anchorFor(html,"Connect Toast")).toBeUndefined();
  expect(html).toContain("Toast setup is unavailable");
  expect(html).not.toContain('href="/more/uploads"');
 });
});

describe("Toast setup destination states",()=>{
 const locations=[{id:"location-1",name:"Main café"}];
 const page=(enabled:boolean)=>renderToStaticMarkup(createElement(ToastConnectionForm,{
  businessId:"business-1",locations,enabled,labels:connectionLabels,
  approvedOrigins:["https://approved.toasttab.com"],defaultApiOrigin:"https://approved.toasttab.com"
 }));
 it("shows clear unavailability with connection status, without an uploads redirect",()=>{
  const html=page(false);
  expect(html).toContain("Toast setup is currently unavailable");
  expect(html).toContain("Saving"); // No false connection claim before the status request completes.
  expect(html).not.toContain('href="/more/uploads"');
  expect(html).not.toContain('>Test Connection</button>');
 });
 it("shows every requested field and action only when setup is authorized",()=>{
  const html=page(true);
  for(const label of ["Client ID","Client Secret",
   "Restaurant GUID","Save","Test Connection"])
    expect(html).toContain(label);
  expect(html).toContain('type="password"');
  expect(html).toContain("Saving");
  expect(html).not.toContain("<span>API URL</span>");
  expect(html).not.toContain("Toast setup is currently unavailable");
  // Test Connection is present but disabled until a configuration exists.
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Test Connection<\/button>/);
 });
 it("shows a dropdown with only approved hosts when there are multiple",()=>{
  const html=renderToStaticMarkup(createElement(ToastConnectionForm,{
   businessId:"business-1",locations,enabled:true,labels:connectionLabels,
   approvedOrigins:["https://one.toasttab.com","https://two.toasttab.com"],defaultApiOrigin:""
  }));
  expect(html).toContain("API URL");
  expect(html).toContain('value="https://one.toasttab.com"');
  expect(html).toContain('value="https://two.toasttab.com"');
 });
});
