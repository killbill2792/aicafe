import {describe,expect,it,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {cafeHighlightedEvents,cityEventChatTarget,CityCatalogView,eventPlanFor} from "./SavedEventsCard";
import {eventContextFromTitle,eventOwnerMessage,eventThreadFromHistory,eventThreadKey,
  eventThreadTitle,openEventDayThread} from "./eventDayThread";
import type {CafeEvent,CityCatalogPage,SavedEventTimeline} from "@/lib/data/cafeEvents.server";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

const day="2026-11-04";
const cafeEvent=(id:string):CafeEvent=>({
  id,name:id,kind:"community",startDate:day,endDate:day,
  startTime:null,endTime:null,venue:null,venueAddress:null,areaLabel:null,
  sourceUrl:"https://city.example.org/"+id,status:"found",
  foundAt:"2026-11-03T10:00:00Z",lastCheckedAt:"2026-11-03T10:00:00Z",
});
const plan=(id:string)=>({
  proposalId:"p-"+id,threadId:"t-"+id,status:"draft",revision:1,
  startDate:day,endDate:day,eventIds:[id],summary:"Review "+id,
  actions:[],expectedBusyHours:[],factsHash:"hash-"+id,reportStatus:null,report:null,
});
const cityEvent=(over:Partial<CityCatalogPage["items"][number]>={}):CityCatalogPage["items"][number]=>({
  id:"22222222-2222-4222-8222-222222222222",name:"Civic Fair",kind:"community",
  startDate:day,endDate:day,startTime:null,endTime:null,timeSourceUrl:null,
  venue:"Hall",venueAddress:"1 Main Street",checkedAt:"2026-11-03T08:00:00Z",
  sources:[{url:"https://city.example.org/fair",observedAt:"2026-11-03T08:00:00Z"}],
  cafeEventId:null,status:null,lastVerifiedAt:null,...over,
});

describe("LDI G — selective café outlook from the one saved Supervisor ledger",()=>{
  it("shows only the selected event out of many discoveries, with no generic discovery alert",()=>{
    const events=Array.from({length:28},(_,i)=>cafeEvent("id-"+i));
    const timeline={events,plans:[plan("id-17")]};
    expect(cafeHighlightedEvents(timeline,day).map(e=>e.id)).toEqual(["id-17"]);
    expect(eventPlanFor(timeline.plans,"id-17",day)?.summary).toBe("Review id-17");
    expect(eventPlanFor(timeline.plans,"id-0",day)).toBeUndefined();
    expect(cafeHighlightedEvents({...timeline,plans:[]},day)).toEqual([]);
  });
  it("keeps café-specific judgment private despite both cafés seeing shared city facts",()=>{
    const publicEvents=[cafeEvent("same-public"),cafeEvent("different")];
    const a={events:publicEvents,plans:[plan("same-public")]};
    const b={events:publicEvents,plans:[plan("different")]};
    expect(cafeHighlightedEvents(a,day).map(e=>e.id)).toEqual(["same-public"]);
    expect(cafeHighlightedEvents(b,day).map(e=>e.id)).toEqual(["different"]);
    expect(cafeHighlightedEvents({events:publicEvents,plans:[]},day)).toEqual([]);
  });
  it("does not reassign old day-only historical reports to an unrelated discovered event",()=>{
    const historic={...plan("old"),eventIds:[],summary:"Historical day-only report"};
    expect(cafeHighlightedEvents({events:[cafeEvent("new")],plans:[historic]},day)).toEqual([]);
    expect(eventPlanFor([historic],"new",day)).toBeUndefined();
    expect(historic.summary).toBe("Historical day-only report");
  });
  it("rejects a stale event analysis from a different day",()=>{
    const late={...plan("id-17"),startDate:"2026-11-05",endDate:"2026-11-05"};
    expect(cafeHighlightedEvents({events:[cafeEvent("id-17")],plans:[late]},day)).toEqual([]);
  });
});

describe("LDI G — exact city event → ONE existing Supervisor thread",()=>{
  it("uses a linked café UUID if present, but distinct city IDs for unlinked events",()=>{
    const unlinked=cityEvent();
    const linked=cityEvent({cafeEventId:"11111111-1111-4111-8111-111111111111"});
    expect(cityEventChatTarget(unlinked)).toEqual({
      date:day,title:"Civic Fair",eventId:undefined,cityEventId:unlinked.id,
    });
    expect(cityEventChatTarget(linked)).toEqual({
      date:day,title:"Civic Fair",eventId:linked.cafeEventId,cityEventId:undefined,
    });
  });
  it("preserves two unlinked city events on the same date in separate threads, even across reload",async()=>{
    const first="11111111-1111-4111-8111-111111111111";
    const second="22222222-2222-4222-8222-222222222222";
    const known=new Map<string,string>();
    const create=vi.fn(async(title:string)=>({id:title.includes(first)?"first":"second"}));
    const select=vi.fn();
    const base={date:day,title:"Civic Fair",known,create,select};
    await openEventDayThread({...base,cityEventId:first});
    await openEventDayThread({...base,cityEventId:second});
    expect(eventThreadKey(day,undefined,first)).not.toBe(eventThreadKey(day,undefined,second));
    const threads=[{id:"first",title:eventThreadTitle(day,"Civic Fair",undefined,first)},
      {id:"second",title:eventThreadTitle(day,"Civic Fair",undefined,second)}];
    expect(eventThreadFromHistory(threads,day,undefined,second)).toBe("second");
    expect(eventThreadFromHistory(threads,day,undefined,first)).toBe("first");
    expect(eventContextFromTitle(threads[1].title,"second")).toEqual({
      date:day,title:"Civic Fair",cityEventId:second,threadId:"second",
    });
    const question=eventOwnerMessage("Assess my café's demand",{
      date:day,title:"Civic Fair",cityEventId:second,threadId:"second",
    });
    expect(question).toContain("@city-event Civic Fair ("+day+") [cityId:"+second+"]");
    expect(question).toContain("Assess my café's demand");
    expect(create).toHaveBeenCalledTimes(2);
    // Thread opening only selects: it never submits a question to the agent.
    expect(select.mock.calls.map(call=>call[0])).toEqual(["first","second"]);
  });
});

describe("LDI G — multilingual, accessible in-place city browsing",()=>{
  it("has every new city-view string in EN/ES/AR, with matching placeholder contracts",()=>{
    const catalogs={en:en.EventsPanel,es:es.EventsPanel,ar:ar.EventsPanel};
    const keys=["forMyCafe","allCityEvents","viewChoice","noCafeOutlook","cafeSelectedHint",
      "cityCatalogScope","searchEvents","category","allCategories","searchButton",
      "cityCoverageRecorded","cityCoverageIncomplete","cityCoverageCounts","researchedOn",
      "researchUnknown","cityUnavailable","cityResults","cityNoResults","previousPage",
      "pageNumber","nextPage","backToCity","sourceStatus","sourceStatusUnknown",
      "listedVerified","cityUnknownDemand","askCitySupervisor","askCityPrompt","sourceUnknown",
      "kindFestival","kindConference","kindSports","kindParade","kindCommunity","kindOther"];
    for(const key of keys){
      const placeholders=(value:string)=>(value.match(/\{[a-zA-Z]+\}/g)??[]).sort();
      const expected=placeholders((catalogs.en as Record<string,string>)[key]);
      for(const locale of ["en","es","ar"] as const){
        const value=(catalogs[locale] as Record<string,string>)[key];
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(3);
        expect(placeholders(value)).toEqual(expected);
      }
    }
  });
  it("renders month navigation, server-side search controls and 48px mobile targets in every language",()=>{
    const catalogs={en:en.EventsPanel,es:es.EventsPanel,ar:ar.EventsPanel};
    for(const locale of ["en","es","ar"] as const){
      const t=(key:string)=>String((catalogs[locale] as Record<string,string>)[key]??key);
      const html=renderToStaticMarkup(createElement(CityCatalogView,{
        today:"2026-11-03",locale,t,chatDisabled:false,onAsk:()=>{},
      }));
      expect(html).toContain(t("searchEvents"));
      expect(html).toContain(t("category"));
      expect(html).toContain(t("previousMonth"));
      expect(html).toContain(t("nextMonth"));
      expect(html).toContain(t("allCategories"));
      expect(html).toContain('type="search"');
      expect(html).toContain('min-h-12');
      expect(html).toContain('rtl:rotate-180');
    }
  });
});
