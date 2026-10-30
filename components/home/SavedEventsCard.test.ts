import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {eventListDays,eventStripDays,latestEventQuestion,eventVenueMapUrl,VenueMapLink} from "./SavedEventsCard";
import type {CafeEvent,SavedEventTimeline} from "@/lib/data/cafeEvents.server";

const event=(id:string,startDate:string,endDate=startDate):CafeEvent=>({
  id,name:id,kind:"community",startDate,endDate,startTime:null,endTime:null,
  venue:"Town center",venueAddress:null,areaLabel:null,sourceUrl:"https://events.example.org",
  status:"found",foundAt:"2026-10-29T10:00:00Z",lastCheckedAt:"2026-10-29T10:00:00Z",
});
const fixture:SavedEventTimeline&{today:string}={
  today:"2026-10-30",
  events:[
    event("past","2026-10-20"),
    event("today","2026-10-30"),
    event("festival","2026-10-31","2026-11-02"),
    event("later","2026-11-05"),
  ],
  plans:[{
    proposalId:"p",threadId:"t",status:"draft",revision:1,
    startDate:"2026-10-31",endDate:"2026-11-02",
    summary:"AI-written plan",actions:[],expectedBusyHours:[],
    factsHash:"hash",reportStatus:null,report:null,
  }],
};
describe("saved events Home calendar",()=>{
  it("always shows seven consecutive café-local dates, including empty days",()=>{
    expect(eventStripDays(fixture.today)).toEqual([
      "2026-10-30","2026-10-31","2026-11-01","2026-11-02",
      "2026-11-03","2026-11-04","2026-11-05",
    ]);
  });
  it("groups multi-day events once, keeps today separate, and shows the past 14 days",()=>{
    expect(eventListDays(fixture,"past",false)).toEqual(["2026-10-20"]);
    expect(eventListDays(fixture,"now",false)).toEqual(["2026-10-30"]);
    expect(eventListDays(fixture,"upcoming",false)).toEqual(["2026-10-31","2026-11-05"]);
  });
  it("only marks a day as affecting the café when an actual saved plan covers it",()=>{
    expect(eventListDays(fixture,"upcoming",true)).toEqual(["2026-10-31"]);
    expect(eventListDays(fixture,"now",true)).toEqual([]);
    expect(eventListDays({...fixture,plans:[]},"upcoming",true)).toEqual([]);
  });
  it("does not drop an event already underway at the edge of the date window",()=>{
    const cross={...fixture,events:[event("long","2026-10-24","2026-11-02")],plans:[]};
    expect(eventListDays(cross,"upcoming",false)).toEqual(["2026-10-31"]);
  });
});

describe("saved event plan question mirrors the Supervisor, not a second question path",()=>{
  it("shows the latest unanswered choice question and opens its conversation for answers",()=>{
    expect(latestEventQuestion([{
      role:"supervisor",blocks:[{type:"clarify",question:"Was Halloween busier?",
        options:[{label:"Busier",value:"more"},{label:"Same",value:"same"}]}],
    }],"en")).toEqual({question:"Was Halloween busier?",options:["Busier","Same"]});
    expect(latestEventQuestion([
      {role:"supervisor",blocks:[{type:"clarify",question:"An old question",options:[]}]},
      {role:"owner",blocks:null},
    ],"en")).toBeNull();
  });
  it("uses the owner-language question and options from an existing owner-question card",()=>{
    expect(latestEventQuestion([{role:"supervisor",blocks:[{
      type:"owner_question",title:{en:"Was it busy?",es:"¿Hubo mucha gente?",ar:"هل كان مزدحمًا؟"},
      input:{kind:"options",options:[{id:"yes",label:{en:"Yes",es:"Sí",ar:"نعم"}}]},
    }]}],"es")).toEqual({question:"¿Hubo mucha gente?",options:["Sí"]});
  });
});

describe("read-only venue map links",()=>{
  const t=(key:string)=>key==="mapLink"?"View in Maps":key;
  it("opens the saved address in Maps without geocoding or a business action",()=>{
    const address="123 Main St, San Francisco, CA";
    const url="https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20San%20Francisco%2C%20CA";
    expect(eventVenueMapUrl("  "+address+"  ")).toBe(url);
    const html=renderToStaticMarkup(createElement(VenueMapLink,{address,t}));
    expect(html).toContain('href="'+url.replace("&","&amp;")+'"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(address);
    expect(html).toContain("View in Maps");
  });
  it("omits map links when the source did not confirm an address",()=>{
    expect(eventVenueMapUrl(null)).toBeNull();
    expect(eventVenueMapUrl("   ")).toBeNull();
    expect(renderToStaticMarkup(createElement(VenueMapLink,{address:null,t}))).toBe("");
    expect(eventVenueMapUrl("Location"+String.fromCharCode(10)+"not confirmed")).toBeNull();
    expect(eventVenueMapUrl("x".repeat(501))).toBeNull();
  });
  it("encodes special characters as a map query, not as a new URL or parameter",()=>{
    expect(eventVenueMapUrl("Hall & Market #3?")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Hall%20%26%20Market%20%233%3F");
  });
});
