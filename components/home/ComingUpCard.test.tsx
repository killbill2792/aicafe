import {describe,it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {createTranslator} from "next-intl";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {ComingUpView,type ComingUpState} from "./ComingUpCard";
import type {EventsOutlook,OutlookDay} from "@/lib/events/outlook";

const t=(locale:"en"|"es"|"ar")=>createTranslator({locale,messages:{en,es,ar}[locale],namespace:"ComingUp"}) as unknown as
  (key:string,values?:Record<string,string|number>)=>string;
const base:Omit<OutlookDay,"date"|"weekday"|"daysFromToday">={holidays:[],eventIds:[],typicalSalesCents:150_000,typicalSampleDays:8,
  lastTime:null,usualHourlySales:[]};
const outlook:EventsOutlook={from:"2026-10-30",to:"2026-11-05",today:"2026-10-30",location:{label:"Austin",source:"profile"},
  country:"US",countrySource:"profile",localEventsSearched:true,notCovered:[],addressMissing:false,hourlySalesQuality:null,
  localEvents:[{id:"e1",name:"Austin AI Week",startDate:"2026-11-02",endDate:"2026-11-05",venue:null,distance:"0.4 mi",
    kind:"conference",expectedCrowd:"large",sourceUrl:"https://e.org",sourceName:null}],
  days:[
    {...base,date:"2026-10-30",weekday:"Friday",daysFromToday:0},
    {...base,date:"2026-10-31",weekday:"Saturday",daysFromToday:1,
      holidays:[{key:"halloween",name:"Halloween",date:"2026-10-31",kind:"observance",dayOff:false}],
      lastTime:{date:"2025-10-31",netSalesCents:132_000,typicalCents:100_000,changePercent:32,sampleDays:5,holiday:"Halloween"}},
    {...base,date:"2026-11-02",weekday:"Monday",daysFromToday:3,eventIds:["e1"]},
    {...base,date:"2026-11-03",weekday:"Tuesday",daysFromToday:4,eventIds:["e1"]},
    {...base,date:"2026-11-04",weekday:"Wednesday",daysFromToday:5,eventIds:["e1"]},
  ]};
const view=(state:ComingUpState,locale:"en"|"es"|"ar"="en")=>renderToStaticMarkup(createElement(ComingUpView,
  {state,locale,t:t(locale),onAsk:()=>{},onChatAboutDay:()=>{},disabled:false}));

describe("Coming up card",()=>{
  it("shows dated facts without writing a staffing verdict, at most three",()=>{
    const html=view({status:"ready",outlook});
    expect(html).toContain("Coming up");
    expect(html).toContain("Tomorrow · Halloween");
    expect(html).not.toContain("Expect more customers");
    expect(html).not.toContain("Add staff");
    expect(html).not.toContain("Busier");
    expect(html).toContain("Last time: +32% vs a usual day");
    expect(html).toContain("Mon, Nov 2 · Austin AI Week");
    expect(html).toContain("Event nearby · 0.4 mi");
    expect(html.match(/<li/gu)).toHaveLength(3);
    expect(html.match(/Chat about this/gu)).toHaveLength(3);
    expect(html).not.toContain("Wed, Nov 4"); // the fourth notable day stays in chat
    expect(html).toContain("Ask about the week");
  });
  it("says a quiet week plainly and asks for the address when missing",()=>{
    const html=view({status:"ready",outlook:{...outlook,days:[outlook.days[0]],localEvents:[],addressMissing:true,location:null}});
    expect(html).toContain("No holidays or local events listed in the next 7 days.");
    expect(html).toContain("Add address");
    expect(html).not.toContain("Ask about the week");
  });
  it("is in the owner's language and stays out of the way while loading or failing",()=>{
    expect(view({status:"ready",outlook},"es")).toContain("Mañana · Halloween");
    expect(view({status:"ready",outlook},"ar")).toContain("غدًا · Halloween");
    expect(view({status:"ready",outlook},"es")).toContain("Hablar de esto");
    expect(view({status:"ready",outlook},"ar")).toContain("تحدث عن هذا");
    expect(view({status:"loading"})).toContain("Checking what");
    expect(view({status:"error"})).toBe("");
  });
});
