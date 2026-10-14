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

import RegisterChoice from "./RegisterChoice";
import ToastConnectionForm from "@/components/more/ToastConnectionForm";

const labels={
 connectSquare:"Connect Square",
 squareNotConfigured:"Square unavailable",
 useToast:"Use Toast",useClover:"Use Clover",useOther:"Use Other",
 csvHint:"Upload CSV files for Clover or Other",
 skip:"Skip"
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
 errorUnavailable:"Unavailable",errorInvalidResponse:"Invalid response"
};

function choice(locale:string,squareConfigured=true){
 return renderToStaticMarkup(createElement(RegisterChoice,{
  locale,squareConfigured,labels
 }));
}
function anchorFor(markup:string,text:string){
 const matches=[...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
 return matches.find(([, ,content])=>content.includes(text));
}

describe("Register choice navigation across mobile locales",()=>{
 it.each(["en","es","ar"])(
  "routes Toast directly to setup and keeps Clover/Other on uploads in %s",locale=>{
   const html=choice(locale);
   expect(anchorFor(html,"Use Toast")?.[1]).toContain('href="/more/toast"');
   expect(anchorFor(html,"Use Clover")?.[1]).toContain('href="/more/uploads"');
   expect(anchorFor(html,"Use Other")?.[1]).toContain('href="/more/uploads"');
   // The complete visual tile remains a single touch/click target.
   for(const label of ["Use Toast","Use Clover","Use Other"]){
    const attrs=anchorFor(html,label)?.[1]??"";
    expect(attrs).toContain("flex");
    expect(attrs).toContain("rounded-2xl");
    expect(attrs).toContain("p-4");
   }
   expect(anchorFor(html,"Skip")?.[1]).toContain('href="/onboarding?step=2"');
  }
 );
 it("preserves Square OAuth with locale and configured/unavailable behavior",()=>{
  expect(anchorFor(choice("es"),"Connect Square")?.[1])
   .toContain('href="/api/pos/square/connect?locale=es"');
  const disabled=choice("es",false);
  const square=anchorFor(disabled,"Connect Square")?.[1]??"";
  expect(square).toContain('href="#"');
  expect(square).toContain('aria-disabled="true"');
  expect(disabled).toContain("Square unavailable");
  expect(anchorFor(disabled,"Use Toast")?.[1]).toContain('href="/more/toast"');
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
  expect(html).toContain("Not connected");
  expect(html).not.toContain('href="/more/uploads"');
  expect(html).not.toContain('>Test Connection</button>');
 });
 it("shows every requested field and action only when setup is authorized",()=>{
  const html=page(true);
  for(const label of ["Client ID","Client Secret",
   "Restaurant GUID","Save","Test Connection"])
    expect(html).toContain(label);
  expect(html).toContain('type="password"');
  expect(html).toContain("Not connected");
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
  expect(html).toContain("<span>API URL</span>");
  expect(html).toContain('value="https://one.toasttab.com"');
  expect(html).toContain('value="https://two.toasttab.com"');
 });
});
