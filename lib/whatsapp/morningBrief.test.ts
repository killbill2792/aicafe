import {describe,expect,it} from "vitest";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {buildBriefContent,briefTemplateFields,prepareMorningBrief,renderMorningBrief,
  type MorningBriefEvidence} from "./morningBrief";
import {CURRENT_TEMPLATE,EVENT_TEMPLATE,NO_EVENT_TEMPLATE,BRIEF_TEMPLATES,briefTemplateFor} from "./briefTemplates";
import {buildOutbound,validTemplateFields} from "./transport";

const now=new Date("2026-11-03T13:50:00.000Z"); // Tue 05:50 PST
const event:CafeEvent={
  id:"event-1",name:"Night market",kind:"festival",startDate:"2026-11-03",
  endDate:"2026-11-03",startTime:"15:00:00",endTime:null,venue:"Main Plaza",
  venueAddress:null,areaLabel:"0.4 mi",sourceUrl:"https://example.org/market",status:"found",
  foundAt:"2026-10-27T18:00:00Z",lastCheckedAt:"2026-11-02T20:00:00Z",
  lastVerifiedAt:"2026-11-02T20:00:00Z",
};
// Seiyun's real Toast menu groups (Nov 2026): café-named, no drink flag from Toast.
const menu=[
  {id:"latte-12",name:"Latte 12 oz",base_name:"Latte",category:"Espresso"},
  {id:"latte-16",name:"Latte 16 oz",base_name:"Latte",category:"Espresso"},
  {id:"adeni",name:"Adeni Tea",base_name:null,category:"Traditional"},
  {id:"samosa",name:"Samosa",base_name:null,category:"Food"},
];
const sold={available:true,linked:[{id:"latte-12",units:5},{id:"latte-16",units:4},
  {id:"adeni",units:7},{id:"samosa",units:12}],unlinked:[]};
function evidence(o:Partial<MorningBriefEvidence>={}):MorningBriefEvidence{
  return {businessName:"Seiyun Yemeni Coffee",currency:"USD",today:"2026-11-03",yesterday:"2026-11-02",
    netSalesCents:139262,sold,menu,categoryLabels:new Map(),
    events:{available:true,items:[],coverage:"complete"},...o};
}
const fieldsOf=(e:MorningBriefEvidence,template=CURRENT_TEMPLATE)=>
  briefTemplateFields(buildBriefContent(e,now),template);

describe("a plain day still gets a full brief",()=>{
  it("no event, no recent owner message, unlabeled categories: sales, items, best seller and an event line",()=>{
    const content=buildBriefContent(evidence(),now);
    expect(content.hasSomethingToSay).toBe(true);
    expect(fieldsOf(evidence())).toEqual(["Seiyun Yemeni Coffee","$1,392.62",
      "28 items in total (drink split not ready yet)","Samosa","12",
      "No major events near you this week.","Tuesday (automatic sales alerts are not on yet)"]);
    expect(content.missing).toEqual(["drink_labels_incomplete"]);
    expect(prepareMorningBrief(content,CURRENT_TEMPLATE)?.fields).toHaveLength(7);
  });
  it("uses drink counts and the best drink once every sold category is labeled, grouping sizes",()=>{
    const labels=new Map([["Espresso",true],["Traditional",true],["Food",false]]);
    expect(fieldsOf(evidence({categoryLabels:labels})).slice(2,5)).toEqual(["16","Latte","9"]);
    expect(fieldsOf(evidence({categoryLabels:labels}),NO_EVENT_TEMPLATE).slice(2,4))
      .toEqual(["16 drinks, 28 items in total","Latte (9 sold)"]);
    // One unlabeled sold category falls back to all items, never a partial drink count.
    const partial=new Map([["Espresso",true],["Food",false]]);
    expect(fieldsOf(evidence({categoryLabels:partial}))[2]).toBe("28 items in total (drink split not ready yet)");
  });
  it("counts items missing from the menu by their POS name",()=>{
    const e=evidence({sold:{available:true,linked:[{id:"latte-12",units:2}],
      unlinked:[{name:"Jubani Coffee",category:null,units:6},{name:"Jubani Coffee",category:null,units:1}]}});
    expect(fieldsOf(e).slice(2,5)).toEqual(["9 items in total (drink split not ready yet)","Jubani Coffee","7"]);
  });
  it("late POS sync: says plainly what is not in yet, never a zero",()=>{
    const e=evidence({netSalesCents:null,sold:{available:false,linked:[],unlinked:[]}});
    const content=buildBriefContent(e,now);
    expect(content.hasSomethingToSay).toBe(true); // the event line still has something to say
    expect(fieldsOf(e).slice(1,5)).toEqual(["not in yet (your POS is still syncing)","not in yet",
      "not in yet","no item data"]);
    expect(content.missing).toEqual(["sales_not_in","items_not_in"]);
    expect(fieldsOf(evidence({netSalesCents:0}))[1]).toBe("$0.00");
  });
  it("a missing currency is said out loud instead of stopping the brief",()=>{
    expect(fieldsOf(evidence({currency:null}))[1]).toBe("1,392.62 (currency not set)");
  });
  it("skips only when there is truly nothing to say",()=>{
    const nothing=evidence({netSalesCents:null,sold:{available:false,linked:[],unlinked:[]},
      events:{available:false,items:[],coverage:null}});
    expect(buildBriefContent(nothing,now).hasSomethingToSay).toBe(false);
    expect(buildBriefContent({...nothing,events:{available:true,items:[],coverage:"partial"}},now)
      .hasSomethingToSay).toBe(false);
  });
});

describe("events: always one line",()=>{
  it("today's event, with or without fresh verification",()=>{
    expect(fieldsOf(evidence({events:{available:true,items:[event],coverage:"complete"}}))[5])
      .toBe("Night market at Main Plaza at 15:00");
    for(const items of [[{...event,lastVerifiedAt:null}],[{...event,lastVerifiedAt:"2026-10-20T00:00:00Z"}],
      [{...event,sourceUrl:null}],[{...event,verificationFailedAt:"2026-11-03T01:00:00Z"}]])
      expect(fieldsOf(evidence({events:{available:true,items,coverage:"complete"}}))[5])
        .toBe("Night market at Main Plaza at 15:00 (not confirmed yet)");
  });
  it("no event today: names the next one within 7 days with day and distance",()=>{
    const later={...event,id:"e2",name:"Farmers market",startDate:"2026-11-07",endDate:"2026-11-07",startTime:null};
    const tooLate={...event,id:"e3",startDate:"2026-11-11",endDate:"2026-11-11"};
    expect(fieldsOf(evidence({events:{available:true,items:[tooLate,later],coverage:"partial"}}))[5])
      .toBe("No events nearby today. Next: Farmers market at Main Plaza, Saturday, 0.4 mi");
    expect(fieldsOf(evidence({events:{available:true,items:[{...later,areaLabel:null}],coverage:"complete"}}))[5])
      .toBe("No events nearby today. Next: Farmers market at Main Plaza, Saturday");
    expect(fieldsOf(evidence({events:{available:true,items:[{...later,areaLabel:null,lastVerifiedAt:null}],coverage:"complete"}}))[5])
      .toBe("No events nearby today. Next: Farmers market at Main Plaza (not confirmed yet), Saturday");
  });
  it("no event this week: 'No major events' only when research completed",()=>{
    const cancelled={...event,status:"cancelled" as const};
    expect(fieldsOf(evidence({events:{available:true,items:[cancelled],coverage:"complete"}}))[5])
      .toBe("No major events near you this week.");
    expect(fieldsOf(evidence({events:{available:true,items:[],coverage:"unsearched"}}))[5])
      .toBe("No confirmed events near you this week.");
    expect(fieldsOf(evidence({events:{available:false,items:[],coverage:null}}))[5])
      .toBe("Today's event check didn't finish.");
  });
  it("event today -> 4-button template; no event -> 3-button template (once Meta approves the split)",()=>{
    expect(briefTemplateFor(true,"split")).toBe(EVENT_TEMPLATE);
    expect(briefTemplateFor(false,"split")).toBe(NO_EVENT_TEMPLATE);
    expect(briefTemplateFor(false,undefined)).toBe(CURRENT_TEMPLATE);
    expect(briefTemplateFor(true,"anything-else")).toBe(CURRENT_TEMPLATE);
    const buttons=(template:typeof CURRENT_TEMPLATE,e:MorningBriefEvidence)=>{
      const p=prepareMorningBrief(buildBriefContent(e,now),template)!;
      const out=buildOutbound("+15556506570",{kind:"daily_brief",template:p.template.name,fields:p.fields}) as
        {template:{name:string;components:{type:string;parameters:{payload?:string;text?:string}[]}[]}};
      return {name:out.template.name,body:out.template.components[0].parameters.map(x=>x.text),
        buttons:out.template.components.slice(1).map(c=>c.parameters[0].payload)};
    };
    const withEvent=evidence({events:{available:true,items:[event],coverage:"complete"}});
    expect(buttons(EVENT_TEMPLATE,withEvent)).toEqual({name:"cafe_profit_brief_event",
      body:["Seiyun Yemeni Coffee","$1,392.62","28 items (drink split not ready yet)","Samosa (12 sold)",
        "Night market at Main Plaza at 15:00"],
      buttons:["money_went","peak_today","slowest_yesterday","event_today"]});
    const plain=buttons(NO_EVENT_TEMPLATE,evidence());
    expect(plain.buttons).toEqual(["money_went","peak_today","slowest_yesterday"]);
    expect(plain.body[4]).toBe("No major events near you this week.");
    expect(buttons(CURRENT_TEMPLATE,evidence()).buttons).toHaveLength(4);
  });
});

describe("Meta blank rules",()=>{
  it("no blank is ever empty, has a newline/tab or 4+ spaces, for every template and data shape",()=>{
    const nasty="  Café\n\t*Bold*    <b>   ";
    const shapes:MorningBriefEvidence[]=[evidence(),
      evidence({businessName:"",netSalesCents:null,sold:{available:false,linked:[],unlinked:[]}}),
      evidence({businessName:nasty,currency:null,
        sold:{available:true,linked:[],unlinked:[{name:nasty,category:nasty,units:3}]},
        events:{available:true,items:[{...event,name:nasty,venue:nasty,areaLabel:nasty}],coverage:"complete"}}),
      evidence({businessName:"A".repeat(400),events:{available:true,
        items:[{...event,name:"B".repeat(400),startDate:"2026-11-05",endDate:"2026-11-05"}],coverage:"partial"}}),
      evidence({sold:{available:true,linked:[{id:"gone",units:2}],unlinked:[]}}),
      evidence({events:{available:false,items:[],coverage:null}}),
    ];
    for(const e of shapes)for(const template of BRIEF_TEMPLATES){
      const fields=fieldsOf(e,template);
      expect(fields).toHaveLength(template.blanks.length);
      expect(validTemplateFields(fields,template.blanks.length)).toBe(true);
      for(const f of fields){
        expect(f.length).toBeGreaterThan(0);
        expect(f).not.toMatch(/[\r\n\t]| {4,}/);
      }
    }
    expect(fieldsOf(shapes[1])[0]).toBe("your café");
    expect(fieldsOf(shapes[4]).slice(3,5)).toEqual(["an item not on your menu","2"]);
  });
  it("renders replacement tokens and nested placeholders literally",()=>{
    const p=prepareMorningBrief(buildBriefContent(evidence({businessName:"Coffee $$ $& {{2}}"}),now),CURRENT_TEMPLATE)!;
    const text=renderMorningBrief(p);
    expect(text).toContain("Here's Coffee $$ $& {{2}}'s daily brief");
    expect(text).toContain("Net sales: $1,392.62");
  });
  it("uses the café-local weekday through DST, not the UTC one",()=>{
    const sunday=evidence({today:"2026-11-01",yesterday:"2026-10-31"});
    expect(fieldsOf(sunday)[6]).toBe("Sunday (automatic sales alerts are not on yet)");
  });
});
