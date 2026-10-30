import {describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {NextIntlClientProvider} from "next-intl";
import ToastOwnerDashboard from "./ToastOwnerDashboard";
import ToastOnboardingChecklist from "./ToastOnboardingChecklist";
import {commitToastOwnerAction,toastActionResult} from "./toastOwnerActionState";
import type {z} from "zod";
import {statusSchema} from "@/lib/pos/toast/statusSchema";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const render=(locale:"en"|"es"|"ar",child:ReturnType<typeof createElement>)=>{
 const messages={en,es,ar}[locale];
 return renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
  {child}
 </NextIntlClientProvider>);
};

for(const locale of ["en","es","ar"] as const){
 it(`shows the ${locale} connection controls before diagnostics load without claiming checklist success`,()=>{
  const html=render(locale,createElement(ToastOwnerDashboard,{businessId,currency:"USD"},
   createElement("button",{type:"button"},"Connect now")));
  expect(html).toContain("Connect now");
  expect(html).toContain({en,es,ar}[locale].ToastConnect.pending);
  expect(html.match(/<li /g)).toHaveLength(8);
  expect(html).not.toContain("✓");
  expect(html).toContain(`dir="${locale==="ar"?"rtl":"ltr"}"`);
 });
}

it("the checklist reflects the exact verified snapshot rather than its own request",()=>{
 const connected={
  connection:"connected",startDate:"2026-10-01",firstImportCheck:"answered",
  analytics:{verified:true}
 } as unknown as z.infer<typeof statusSchema>;
 const html=render("en",createElement(ToastOnboardingChecklist,{businessId,status:connected}));
 expect(html.match(/✓/g)).toHaveLength(8);
 expect(html).not.toContain('aria-hidden="true">…');
 const unknown=render("en",createElement(ToastOnboardingChecklist,{businessId,status:null}));
 expect(unknown.match(/aria-hidden="true">…/g)).toHaveLength(8);
 expect(unknown).not.toContain("✓");
});

describe("confirmed Toast operations must not wait for diagnostics to acknowledge results",()=>{
 it("shows a queued re-pull result before a slow status refresh completes",async()=>{
  let finishRefresh:()=>void=()=>{};
  let refreshStarted:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{refreshStarted=resolve;});
  const refresh=vi.fn(()=>{refreshStarted();return new Promise<void>(resolve=>{finishRefresh=resolve;});});
  const outcome=toastActionResult("repull",202,{runIds:["queued"]});
  const onCommitted=vi.fn();
  const action=commitToastOwnerAction(async()=>{expect(outcome).toEqual({ok:true,key:"ownerRepullQueued"});},
   refresh,onCommitted);
  await started;
  expect(onCommitted).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  finishRefresh();
  await expect(action).resolves.toEqual({refreshAvailable:true});
 });
 it("does not announce a rejected Looks right as committed",async()=>{
  const onCommitted=vi.fn(),refresh=vi.fn();
  const denied=toastActionResult("first_check",403,{error:"not_authorized"});
  await expect(commitToastOwnerAction(async()=>{if(!denied.ok)throw Error(denied.key);},
   refresh,onCommitted)).rejects.toThrow("ownerNotAuthorized");
  expect(onCommitted).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
 });
 it("preserves already-answered truth even when the subsequent status read fails",async()=>{
  const already=toastActionResult("first_check",409,{error:"already_answered"});
  expect(already).toEqual({ok:true,key:"ownerAlreadyAnswered"});
  const onCommitted=vi.fn();
  await expect(commitToastOwnerAction(async()=>{},async()=>{throw Error("unavailable");},onCommitted))
   .resolves.toEqual({refreshAvailable:false});
  expect(onCommitted).toHaveBeenCalledTimes(1);
 });
});
