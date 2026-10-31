import {describe,expect,it} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {eventListDays,eventStripDays,latestEventQuestion,eventVenueMapUrl,VenueMapLink,EventsTabs,eventChatTarget,EventAdviceItem,SavedEventListCard,selectedSavedEvent,eventDetailDay,eventPlanFor,SavedEventAnalysis} from "./SavedEventsCard";
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

describe("Events Fix C date and saved-importance contract",()=>{
  const snapshot=(today:string)=>({...fixture,today});
  it("moves Halloween from Upcoming to Today to Past only on café-local dates",()=>{
    expect(eventListDays(snapshot("2026-10-30"),"upcoming",false)).toContain("2026-10-31");
    expect(eventListDays(snapshot("2026-10-30"),"now",false)).not.toContain("2026-10-31");
    expect(eventListDays(snapshot("2026-10-31"),"now",false)).toContain("2026-10-31");
    expect(eventListDays(snapshot("2026-11-01"),"past",false)).toContain("2026-10-31");
    expect(eventListDays(snapshot("2026-11-01"),"upcoming",false)).not.toContain("2026-10-31");
  });
  it("sorts only the next 7 days by saved AI importance, supports date toggle and keeps older rows chronological",()=>{
    const timeline={...fixture,events:[
      event("low","2026-11-01"),event("high","2026-11-03"),event("unknown","2026-11-04"),
      event("later","2026-11-09"),event("further","2026-11-10"),
    ],plans:[
      {...fixture.plans[0],startDate:"2026-11-01",endDate:"2026-11-01",importance:"low" as const},
      {...fixture.plans[0],proposalId:"p2",startDate:"2026-11-03",endDate:"2026-11-03",importance:"high" as const},
    ]};
    expect(eventListDays(timeline,"upcoming",false)).toEqual([
      "2026-11-03","2026-11-01","2026-11-04","2026-11-09","2026-11-10",
    ]);
    expect(eventListDays(timeline,"upcoming",false,true)).toEqual([
      "2026-11-01","2026-11-03","2026-11-04","2026-11-09","2026-11-10",
    ]);
    const withoutImportance={...timeline,plans:timeline.plans.map(p=>({...p,importance:null}))};
    expect(eventListDays(withoutImportance,"upcoming",false)).toEqual(
      eventListDays(withoutImportance,"upcoming",false,true));
  });
  it("keeps Past reports newest first and today's result separate from upcoming",()=>{
    const timeline={...fixture,today:"2026-11-06",events:[
      event("past1","2026-10-31"),event("past2","2026-11-05"),event("future","2026-11-07"),
    ],plans:[]};
    expect(eventListDays(timeline,"past",false)).toEqual(["2026-11-05","2026-10-31"]);
    expect(eventListDays(timeline,"now",false)).toEqual([]);
    expect(eventListDays(timeline,"upcoming",false)).toEqual(["2026-11-07"]);
  });
});

describe("persistent Events category navigation",()=>{
  const t=(key:string)=>({past:"Past",now:"Today",upcoming:"Upcoming",title:"Events near your café"} as Record<string,string>)[key]??key;
  it("renders three accessible choices and identifies the selected category",()=>{
    const html=renderToStaticMarkup(createElement(EventsTabs,{tab:"upcoming",onChoose:()=>{},t}));
    for(const label of ["Past","Today","Upcoming"])expect(html).toContain(label);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Events near your café"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/min-h-12/g)).toHaveLength(3);
  });
});

describe("per-event chat selection",()=>{
  const sameDay="2026-10-31";
  const a=event("event-a",sameDay),b=event("event-b",sameDay);
  it("never substitutes the first event when the owner taps another card on that date",()=>{
    const plan={summary:"Shared day outlook",threadId:"shared-day-thread"};
    const first=eventChatTarget(sameDay,a,plan);
    const second=eventChatTarget(sameDay,b,plan);
    expect(first).toEqual({date:sameDay,title:"event-a",eventId:"event-a",existingThreadId:undefined});
    expect(second).toEqual({date:sameDay,title:"event-b",eventId:"event-b",existingThreadId:undefined});
    expect(second.eventId).not.toBe(first.eventId);
  });
  it("keeps the day report's existing thread without pretending an event was tapped",()=>{
    expect(eventChatTarget(sameDay,undefined,{summary:"Shared outlook",threadId:"day-thread"}))
      .toEqual({date:sameDay,title:"Shared outlook",eventId:undefined,existingThreadId:"day-thread"});
  });
});

describe("saved event advice is informational, not a checklist",()=>{
  it("shows a recognizable recommendation icon and the original AI explanation",()=>{
    const html=renderToStaticMarkup(createElement(EventAdviceItem,{
      action:{area:"operations",action:"Review normal Saturday supplies",
        reason:"No prior Halloween trading record; use the usual Saturday baseline."},
    }));
    expect(html).toContain("<li");
    expect(html).toContain("<svg");
    expect(html).toContain("Review normal Saturday supplies");
    expect(html).toContain("No prior Halloween trading record");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });
});

describe("opening a specific saved event from the Events list",()=>{
  const translations={
    en:{openEvent:"Open {title} on {date}",readInsights:"Read event insights"},
    es:{openEvent:"Abrir {title} el {date}",readInsights:"Ver análisis del evento"},
    ar:{openEvent:"فتح {title} بتاريخ {date}",readInsights:"عرض تحليل الحدث"},
  } as const;
  it("makes each event title/date a large clickable target without showing save-check metadata",()=>{
    const halloween={...event("halloween","2026-10-31"),name:"Halloween at The EndUp",
      venue:null,areaLabel:null,lastVerifiedAt:null};
    for(const locale of ["en","es","ar"] as const){
      const t=(key:string,values?:Record<string,string|number>)=>{
        const template=(translations[locale] as Record<string,string>)[key]??key;
        return template.replace(/\{(\w+)\}/g,(_,name:string)=>String(values?.[name]??""));
      };
      const html=renderToStaticMarkup(createElement(SavedEventListCard,{
        event:halloween,locale,t,onOpen:()=>{},hasAnalysis:true,
      }));
      expect(html).toContain('type="button"');
      expect(html).toContain("Halloween at The EndUp");
      expect(html).toContain("2026");
      expect(html).toContain(translations[locale].readInsights);
      expect(html).not.toContain("Last saved check");
      expect(html).not.toContain("Venue not recorded");
      expect(html).not.toContain("Verification incomplete");
      expect(html.match(/<button\b/g)).toHaveLength(1);
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("<a ");
    }
  });
  it("opens an ongoing event on the displayed Today date, not its past start day",()=>{
    const ongoing=event("multi-day","2026-10-27","2026-11-02");
    expect(eventDetailDay(ongoing,"2026-10-30")).toBe("2026-10-30");
    expect(selectedSavedEvent([ongoing],"2026-10-30",ongoing.id)).toEqual(ongoing);
    // The owner can still deliberately open historical dates from the Past list.
    expect(eventDetailDay(ongoing,"2026-10-29")).toBe("2026-10-29");
    expect(eventDetailDay(ongoing,"2026-11-05")).toBe("2026-10-27");
  });
  it("opens the exact clicked event, even when two have the same start date",()=>{
    const first={...event("one","2026-10-31"),name:"Halloween market"};
    const second={...event("two","2026-10-31"),name:"Halloween concert"};
    expect(selectedSavedEvent([first,second],"2026-10-31","two")).toEqual(second);
    expect(selectedSavedEvent([first,second],"2026-10-31","one")).toEqual(first);
    expect(selectedSavedEvent([first,second],"2026-11-01","two")).toBeNull();
    expect(selectedSavedEvent([first,second],"2026-10-31","nonexistent")).toBeNull();
    const clicked:CafeEvent[]=[];
    const card=SavedEventListCard({event:second,locale:"en",
      t:(key,values)=>key==="openEvent"?String(values?.title):key,
      onOpen:e=>clicked.push(e),hasAnalysis:false,
    }) as {props:{children:{props:{onClick:()=>void}}}};
    card.props.children.props.onClick();
    expect(clicked).toEqual([second]);
    const html=renderToStaticMarkup(createElement(SavedEventListCard,{
      event:second,locale:"en",hasAnalysis:false,onOpen:()=>{},
      t:key=>key==="viewEventDetails"?"View event details":key,
    }));
    expect(html).toContain("View event details");
    expect(html).not.toContain("Read event insights");
  });
});

describe("saved AI analysis inside a selected event detail",()=>{
  const t=(key:string,values?:Record<string,string|number>)=>
    key==="dayWideInsight"?"Analysis covers "+values?.date+" and may include other events":
    key==="noEventInsight"?"No saved AI analysis for this event yet":key;
  const selected={...event("halloween","2026-10-31"),name:"Halloween at The EndUp"};
  const props={selectedEvent:selected,date:"2026-10-31",today:"2026-10-30",
    currency:"USD",locale:"en" as const,t,onChat:()=>{}};
  it("opens the saved day-wide AI reasoning and preparation advice for the chosen event",()=>{
    const plan={...fixture.plans[0],summary:"Expect late-night pedestrian traffic",
      expectedBusyHours:[{start:"20:00",end:"23:00"}],
      actions:[{area:"operations",action:"Check usual Saturday staffing",
        reason:"Visitor volume may differ from the usual evening"}]};
    const html=renderToStaticMarkup(createElement(SavedEventAnalysis,{...props,plan}));
    expect(html).toContain("Expect late-night pedestrian traffic");
    expect(html).toContain("20:00");
    expect(html).toContain("Check usual Saturday staffing");
    expect(html).toContain("Visitor volume may differ");
    expect(html).toContain("Analysis covers");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Last saved check");
  });
  it("is transparent when no AI plan was saved instead of inventing an analysis",()=>{
    const html=renderToStaticMarkup(createElement(SavedEventAnalysis,{...props,plan:undefined}));
    expect(html).toContain("No saved AI analysis for this event yet");
    expect(html).not.toContain("Expect late-night pedestrian traffic");
  });
});

describe("date- and ID-scoped event AI analysis",()=>{
  const plan=(id:string,startDate:string,endDate:string,status="draft")=>({
    ...fixture.plans[0],proposalId:id,startDate,endDate,eventIds:[id],
    status,summary:id+" explanation",
  });
  it("never attaches another same-day event's AI plan to the tapped card",()=>{
    const first=plan("first","2026-10-31","2026-10-31");
    const second=plan("second","2026-10-31","2026-10-31");
    expect(eventPlanFor([first,second],"first","2026-10-31")).toEqual(first);
    expect(eventPlanFor([first,second],"second","2026-10-31")).toEqual(second);
    expect(eventPlanFor([first,second],"third","2026-10-31")).toBeUndefined();
    expect(eventPlanFor([{...first,eventIds:undefined}],"first","2026-10-31"))
      .toBeUndefined();
  });
  it("keeps each day of a multi-day event's saved analysis separate",()=>{
    const saturday={...plan("festival","2026-10-31","2026-10-31"),summary:"Saturday"};
    const sunday={...plan("festival","2026-11-01","2026-11-01"),
      proposalId:"sunday",summary:"Sunday"};
    expect(eventPlanFor([sunday,saturday],"festival","2026-10-31")?.summary)
      .toBe("Saturday");
    expect(eventPlanFor([sunday,saturday],"festival","2026-11-01")?.summary)
      .toBe("Sunday");
    expect(eventPlanFor([sunday,saturday],"festival","2026-10-30"))
      .toBeUndefined();
    expect(eventDetailDay(event("festival","2026-10-30","2026-11-02"),
      "2026-10-31")).toBe("2026-10-31");
  });
  it("preserves the approved event plan instead of another draft",()=>{
    const draft=plan("festival","2026-10-31","2026-10-31");
    const committed={...draft,status:"committed",proposalId:"approved"};
    expect(eventPlanFor([draft,committed],"festival","2026-10-31"))
      .toEqual(committed);
  });
});
