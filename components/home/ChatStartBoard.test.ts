import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement,type ReactNode} from "react";
vi.mock("@/components/shared/PeriodSwitch",()=>({default:()=>createElement("div",null,"period")}));
vi.mock("@/i18n/navigation",()=>({Link:({children,href,...props}:{children:ReactNode;href:string})=>createElement("a",{href,...props},children)}));
vi.mock("@/components/operations/agentVisuals",()=>({AgentAvatar:()=>createElement("span",null,"avatar")}));
import ChatStart,{type ChatStartCopy,type ChatStartData} from "./ChatStart";

const copy:ChatStartCopy={keyNumbers:"Key numbers",sales:"Sales",knownCosts:"Known costs",youKeep:"You keep",
  partial:"Partial",estimate:"Estimate",incomplete:"Incomplete",details:"Details",seeAll:"See all",allGood:"All good",
  summary:"Summary",roles:{alex:"Pricing",leo:"Money",maya:"Supplies",olivia:"Staff"},suggestions:[],
  experimentPrompt:"",suggestionsLabel:"Ask",handledLabel:"Handled",boardRunning:"Running",boardReports:"Recent reports"};
const data:ChatStartData={period:"today",sales:"—",costs:"—",kept:"—",attention:[],partial:false,estimated:false,
  incomplete:false,shareCaption:null,comparisonCaption:null};
const render=(board:ChatStartData["board"])=>renderToStaticMarkup(createElement(ChatStart,{data:{...data,board},copy,
  hasMessages:false,expanded:false,onToggle:()=>{},onSuggestion:()=>{},suggestionsDisabled:false}));

describe("Operating Board on the chat start",()=>{
  it("shows running experiments and recent reports, each linking to its chat thread",()=>{
    const html=render({running:[{key:"p1",href:"/?thread=t1&experiment=p1",text:"Latte: 4.50 → 4.75 · day 3 of 7"}],
      reports:[{key:"p2",href:"/?thread=t2&experiment=p2",text:"Mocha: report ready · keep the new price"}]});
    expect(html).toContain('data-testid="operating-board"');
    expect(html).toContain("Running");
    expect(html).toContain("day 3 of 7");
    expect(html).toContain('href="/?thread=t1&amp;experiment=p1"');
    expect(html).toContain("Recent reports");
    expect(html).toContain("keep the new price");
  });
  it("hides the board when nothing is running or reported",()=>{
    expect(render({running:[],reports:[]})).not.toContain("operating-board");
    expect(render(undefined)).not.toContain("operating-board");
  });
});
