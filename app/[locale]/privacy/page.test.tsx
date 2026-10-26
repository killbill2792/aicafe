import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const state=vi.hoisted(()=>({locale:"en" as "en"|"es"|"ar"}));
const dictionaries={en,es,ar};
vi.mock("next-intl/server",()=>({
 getTranslations:async(section:string)=>(key:string)=>
  (dictionaries[state.locale] as unknown as Record<string,Record<string,string>>)[section]?.[key]??key
}));
vi.mock("@/i18n/navigation",()=>({
 Link:({href,children}:{href:string;children:ReactNode})=>createElement("a",{href},children)
}));
vi.mock("@/components/shared/BackHeader",()=>({
 default:({title,subtitle}:{title:string;subtitle:string})=>createElement("header",null,title,subtitle)
}));
vi.mock("@/components/shared/PageShell",()=>({
 default:({children}:{children:ReactNode})=>createElement("main",null,children)
}));
import PrivacyPage from "./page";

describe("public draft privacy policy",()=>{
 it.each(["en","es","ar"] as const)(
  "renders seven substantive sections, draft disclosure and delete route in %s",async(locale)=>{
   state.locale=locale;
   // No authenticated session is supplied; page itself must be public.
   const html=renderToStaticMarkup(await PrivacyPage());
   const t:Record<string,string>=dictionaries[locale].Privacy;
   expect((html.match(/<section\b/g)??[])).toHaveLength(7);
   expect(html).toContain(t.draftBanner);
   for(const key of ["whatWeCollect","toastSquare","aiProcessing","staffMessages","retention",
      "deletingYourAccount","contact"] as const){
    expect(html).toContain(t[key+"Title"]);
    expect(html).toContain(t[key+"Body"].replace(/&/g,"&amp;"));
   }
   expect(html).toContain('href="/more/delete-account"');
   expect(html).toContain(t.lastUpdated);
  }
 );
 it("retains explicit legal placeholders in all languages",()=>{
  for(const locale of ["en","es","ar"] as const){
   expect(dictionaries[locale].Privacy.retentionBody).toContain("[X days]");
   expect(dictionaries[locale].Privacy.contactBody).toContain("[privacy contact email");
  }
 });
});