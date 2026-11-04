import {describe,expect,it} from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {NAV_TABS,isNavTabActive} from "./navTabs";

describe("main navigation",()=>{
  it("has Inbox right after Home, opening the Operations inbox",()=>{
    expect(NAV_TABS.map(tab=>[tab.key,tab.href]).slice(0,2)).toEqual([["home","/"],["inbox","/operations"]]);
    for(const messages of [en,es,ar])expect(messages.Nav.inbox.length).toBeGreaterThan(1);
  });
  it("keeps Inbox highlighted on the Experiments page",()=>{
    expect(isNavTabActive("/operations/experiments","/operations")).toBe(true);
    expect(isNavTabActive("/money","/operations")).toBe(false);
  });
});
