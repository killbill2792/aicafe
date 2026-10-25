import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { topChatStartItems } from "./chatStartAttention";
import type { ChatStartAttentionItem } from "./chatStartAttention";
import { vi } from "vitest";
vi.mock("@/components/shared/PeriodSwitch", () => ({default:()=>createElement("div", {role:"group"}, "Today · Week · Month to date")}));
vi.mock("@/i18n/navigation", () => ({ Link:({children,href,...props}:{children:import("react").ReactNode;href:string})=>createElement("a",{href,...props},children) }));
vi.mock("@/components/operations/agentVisuals", () => ({ AgentAvatar:()=>createElement("span",null,"avatar") }));
import ChatStart, { type ChatStartCopy, type ChatStartData } from "./ChatStart";

const attention: ChatStartAttentionItem[] = [
  { id:"a1",agentId:"alex",displayTitle:"Older",actionLabel:"Fix",href:"/menu/a1",impactCents:100 },
  { id:"l1",agentId:"leo",displayTitle:"Bill",actionLabel:"Review",href:"/money",impactCents:null },
  { id:"a2",agentId:"alex",displayTitle:"Top",actionLabel:"Fix",href:"/menu/a2",impactCents:200 },
  { id:"m1",agentId:"maya",displayTitle:"Supply",actionLabel:"Check",href:"/operations",impactCents:50 },
  { id:"a3",agentId:"alex",displayTitle:"Tie",actionLabel:"Fix",href:"/menu/a3",impactCents:200 },
];
const copy: ChatStartCopy = {
 keyNumbers:"Key numbers",sales:"Sales",knownCosts:"Known business costs",youKeep:"You keep",
 partial:"Partial",estimate:"Estimate",incomplete:"Costs incomplete",details:"Details",
 seeAll:"See all (5)",allGood:"All good",summary:"Today: Sales $500 · You keep — · 5 things need you",
 roles:{alex:"Pricing",leo:"Money",maya:"Supplies",olivia:"Staff"},
 suggestions:["How are we doing today?","What needs my attention?","Any staff issues?","Try a drink price experiment"],
 experimentPrompt:"I want to try a drink price experiment", suggestionsLabel:"Ask anything",handledLabel:"See handled",
};
const data: ChatStartData = {period:"today",sales:"$500",costs:"$200",kept:"—",
 attention,partial:false,estimated:false,incomplete:true,
 shareCaption:"42% of sales",comparisonCaption:"18% more vs last period"};
describe("PR F shared attention and chat entry",()=>{
 it("picks the highest impact, stable ties, and no invented Olivia card",()=>{
  const top=topChatStartItems(attention);
  expect(top.alex?.id).toBe("a2");
  expect(top.alex?.href).toBe("/menu/a2");
  expect(top.leo?.id).toBe("l1");
  expect(top.maya?.id).toBe("m1");
  expect(top.olivia).toBeUndefined();
 });
 it("uses one source, keeps the fourth starter, and never shows old accordion",()=>{
  const markup=renderToStaticMarkup(createElement(ChatStart,{
    data,copy,hasMessages:false,expanded:false,onToggle:()=>{},onSuggestion:()=>{},suggestionsDisabled:false,
  }));
  expect(markup).toContain("Known business costs");
  expect(markup).toContain("Today");
  for(const name of ["Alex","Leo","Maya","Olivia"])expect(markup).toContain(name);
  expect(markup).toContain("Try a drink price experiment");
  expect(markup).toContain('data-attention-id="a2"');
  expect(markup).toContain('href="/menu/a2"');
  expect(markup).toContain("All good");
  expect(markup).toContain("42% of sales");
  expect(markup).toContain("18% more vs last period");
  expect(markup).toContain('href="/operations?status=handled"');
  expect(markup).toContain("See handled");
  expect(markup).not.toContain("SupervisorExperiment");
 });
 it("does not fabricate a comparison when current or prior-period evidence is incomplete",()=>{
  const html=renderToStaticMarkup(createElement(ChatStart,{
    data:{...data,kept:"—",shareCaption:null,comparisonCaption:null},
    copy,hasMessages:false,expanded:false,onToggle:()=>{},onSuggestion:()=>{},suggestionsDisabled:false,
  }));
  expect(html).not.toContain("42% of sales");
  expect(html).not.toContain("18% more vs last period");
  expect(html).toContain("Costs incomplete");
 });
 it("collapses for an existing thread and reopens with aria-expanded",()=>{
  const render=(expanded:boolean)=>renderToStaticMarkup(createElement(ChatStart,{
    data,copy,hasMessages:true,expanded,onToggle:()=>{},onSuggestion:()=>{},suggestionsDisabled:false,
  }));
  expect(render(false)).toContain('aria-expanded="false"');
  expect(render(false)).not.toContain('data-attention-id="a2"');
  expect(render(true)).toContain('aria-expanded="true"');
  expect(render(true)).toContain('data-attention-id="a2"');
 });
 it("removes duplicate Home list and experiment panel, guards rapid sends",()=>{
  const home=readFileSync("app/[locale]/page.tsx","utf8");
  const composer=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
  expect(home).not.toContain("<HomeTaskSections");
  expect(home).toContain('handledLabel:t("attentionHandled")');
  expect(home).toContain('profitChangePct===null?null');
  expect(home).toContain('canShowProfit&&moneyVm.salesCents>0');
  expect(home).not.toContain("<CostRecoveryStrip");
  expect(home).not.toContain('<section aria-label={t("keyNumbers")}');
  expect(composer).not.toContain("{enabled&&threadId&&experimentCopy&&<SupervisorExperiment");
  expect(composer).toContain('block.type==="experiment_card"');
  expect(composer).toContain("<ClarifyCard");
  expect(composer).toContain("<HowIGotThis");
  expect(composer).not.toContain("copy.suggestions.slice(0,3)");
  expect(composer).toContain("if(sendOnce.current)return");
  expect(composer).toContain("sendOnce.current=true");
  expect(composer).toContain("sendOnce.current=false");
  const followUp = composer.indexOf("return sendFollowUp(text);", composer.indexOf("async function sendText"));
  const mainGuard = composer.indexOf("if(sendOnce.current)return;", composer.indexOf("async function sendText"));
  expect(followUp).toBeGreaterThan(0);
  expect(mainGuard).toBeGreaterThan(followUp);
  expect(composer).toContain("pendingFollowUps.current.add(text)");
  expect(composer).toContain("pendingFollowUps.current.delete(text)");
  expect(composer).toContain("setStartExpanded(false)");
 });
 it("restores old exact experiment links without a standalone accordion on every chat",()=>{
  const home=readFileSync("app/[locale]/page.tsx","utf8");
  const wrapper=readFileSync("components/home/SupervisorHomePanel.tsx","utf8");
  const composer=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
  expect(home).toContain('initialThreadId={initialThread} initialProposalId={initialExperiment}');
  expect(wrapper).toContain('initialThreadId={initialThreadId} initialProposalId={initialProposalId}');
  // Fails on the old branch: client-side deep links changed only props, not
  // the useState-initialized thread, so owner opened the wrong conversation.
  expect(wrapper).toContain('key={(initialThreadId ?? "new") + ":" + (initialProposalId ?? "")}');
  expect(composer).toContain('initialProposalId && initialThreadId && threadId === initialThreadId');
  expect(composer).toContain('initialProposalId={initialProposalId}');
  expect(composer).toContain('copy={{en,es,ar}[locale].SupervisorExperiment}');
  expect(composer).not.toContain('{enabled&&threadId&&experimentCopy&&<SupervisorExperiment');
 });
 it("shows an explicit reason when chat is unavailable instead of only disabled chips",()=>{
  const html=renderToStaticMarkup(createElement(ChatStart,{
    data,copy,hasMessages:false,expanded:false,onToggle:()=>{},onSuggestion:()=>{},
    suggestionsDisabled:true,unavailableMessage:"Chat is unavailable while setup is incomplete",
  }));
  expect(html).toContain('role="status"');
  expect(html).toContain("Chat is unavailable while setup is incomplete");
  expect(readFileSync("components/home/SupervisorChatComposer.tsx","utf8"))
    .toContain('unavailableMessage={!enabled ? copy.unavailable : undefined}');
 });
 it("keeps token-only classes, localized single-message summary and RTL-safe layout",()=>{
  const ui=readFileSync("components/home/ChatStart.tsx","utf8");
  expect(ui).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|-(?:red|green|amber|gray|slate)-\d+/);
  expect(ui).toContain('grid grid-cols-2');
  expect(ui).toContain('dir="inherit"');
  for(const locale of ["en","es","ar"]){
    const messages=JSON.parse(readFileSync(`messages/${locale}.json`,"utf8")) as {Home:Record<string,string>};
    expect(messages.Home.chatStartSummary).toContain("{period}");
    expect(messages.Home.chatStartSummary).toContain("{sales}");
    expect(messages.Home.chatStartSummary).toContain("{kept}");
    expect(messages.Home.chatStartSummary).toContain("{count, plural,");
    expect(messages.Home.suggestionPrices).toBeTruthy();
  }
 });
});
