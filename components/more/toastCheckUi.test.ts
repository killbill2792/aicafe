import {it,expect} from "vitest";
import {createElement,type ComponentProps} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {NextIntlClientProvider} from "next-intl";
import Comparison from "./ToastSummaryComparison";
import Checklist from "./ToastOnboardingChecklist";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
for(const [locale,messages] of [["en",en],["es",es],["ar",ar]] as const){
 it(`renders the ${locale} report inputs and checklist with all translated keys`,()=>{
  const days=Array.from({length:7},(_,i)=>({date:`2026-10-${String(i+10)}`,restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",oursCents:123456}));
  const render=(child:ReturnType<typeof createElement>)=>renderToStaticMarkup(createElement(NextIntlClientProvider,{locale,messages,timeZone:"UTC"} as ComponentProps<typeof NextIntlClientProvider>,child));
  const html=render(createElement(Comparison,{businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",days,currency:"USD",onSaved:async()=>{}}));
  expect(html).toContain(`dir="${locale==="ar"?"rtl":"ltr"}"`);
  expect(html.match(/name="net"/g)).toHaveLength(7);
  expect(html).toContain(messages.ToastConnect.summaryTitle);
  expect(html).toContain('min-h-12');expect(html).not.toContain("MISSING_MESSAGE");
  const checklist=render(createElement(Checklist,{businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}));
  expect(checklist).toContain('orders:read');expect(checklist).toContain('labor.employees:read');
  expect(checklist.match(/<li /g)).toHaveLength(8);expect(checklist).not.toContain("MISSING_MESSAGE");
 });
}
