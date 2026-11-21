import {describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {readFileSync} from "node:fs";

vi.mock("@/i18n/navigation",()=>({Link:({children,href,...props}:{children:import("react").ReactNode;href:string})=>createElement("a",{href,...props},children)}));
vi.mock("@/components/shared/PeriodSwitch",()=>({default:()=>createElement("div",null,"period")}));
vi.mock("@/components/operations/agentVisuals",()=>({AgentAvatar:()=>createElement("span",null,"avatar")}));
import SupervisorChatComposer,{type SupervisorChatCopy} from "./SupervisorChatComposer";
import type {ChatStartCopy,ChatStartData} from "./ChatStart";

const copy={suggestions:["a","b","c","d"],unavailable:"Chat unavailable"} as unknown as SupervisorChatCopy;
const chatStartData:ChatStartData={period:"today",sales:"$300",costs:"$225",kept:"$75",attention:[],
  partial:false,estimated:false,incomplete:false,shareCaption:null,comparisonCaption:null};
const chatStartCopy={keyNumbers:"Key numbers",sales:"Sales",knownCosts:"Known costs",youKeep:"You keep",partial:"Partial",
  estimate:"Estimated",incomplete:"Costs incomplete",details:"Details",seeAll:"See all",allGood:"All good",summary:"s",
  roles:{alex:"",leo:"",maya:"",olivia:""},experimentPrompt:"x",suggestionsLabel:"y",handledLabel:"z"} as Omit<ChatStartCopy,"suggestions">;
const html=(props:{enabled:boolean;canUseAi?:boolean})=>renderToStaticMarkup(createElement(SupervisorChatComposer,
  {cafeCurrency:"USD",unavailableReason:null,locale:"en",copy,chatStartData,chatStartCopy,...props}));

describe("Coming up card and AI access",()=>{
  it("keeps Events available on demand but out of the default conversation",()=>{
    expect(html({enabled:true})).not.toContain('data-testid="coming-up"');
    const source=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    expect(source).toContain("enabled && canUseAi ? <SavedEventsCard");
    expect(source).toContain('{startExpanded && <aside id="supervisor-chat-insights"');
    expect(source).toContain("comingUp={comingUpCard}");
  });
  it("is never mounted (so never fetches the paid search) without AI access or with chat off",()=>{
    expect(html({enabled:true,canUseAi:false})).not.toContain('data-testid="coming-up"');
    expect(html({enabled:false})).not.toContain('data-testid="coming-up"');
  });
});
