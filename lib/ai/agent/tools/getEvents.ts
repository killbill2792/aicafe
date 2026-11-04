import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

export const getEventsInput=z.strictObject({from:z.iso.date(),to:z.iso.date(),
 cityEventId:z.uuid().nullish()});
/** Keep chat tool evidence compact. Full readings remain in the one shared data reader. */
function compactReport(raw:unknown):Record<string,unknown>|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const r=raw as Record<string,unknown>;
 const days=Array.isArray(r.days)?r.days.filter(d=>d&&typeof d==="object").slice(0,7)
   .map(d=>{const x=d as Record<string,unknown>;return {
     date:x.date,actualCents:x.actualCents,typicalCents:x.typicalCents,
     changePercent:x.changePercent,baselineDays:x.baselineDays};}):[];
 return {observedDays:r.observedDays??null,expectedDays:r.expectedDays??null,
   checklist:r.checklist??null,days,additionalDays:Array.isArray(r.days)?Math.max(0,r.days.length-days.length):0};
}
export const savedEventsTools={
 get_events:{
  agentId:"alex",
  schema:getEventsInput,
  description:"Read SAVED nearby events and holidays for any past or future date range (at most 90 days). If the owner selects a public city event ([cityId:UUID]), pass cityEventId to retrieve that EXACT saved city record even when outside the first six events, including confirmed venue, hours, sources, research freshness and saved verification status. including the owner's approved/draft event-readiness plans and existing Supervisor report status and measurements. Use for 'what is planned for Halloween?', 'how did Halloween go?', or events already found. No web search is triggered. Don't claim a plan was executed when still draft, and don't invent a report for missing evidence.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const v=getEventsInput.parse(raw);
   const ms=Date.parse(v.to+"T00:00:00Z")-Date.parse(v.from+"T00:00:00Z");
   if(v.from>v.to||ms>90*86400000)throw new Error("Invalid saved event range");
   if(!ctx.savedEvents)return {source:"cafe_events",period:{from:v.from,to:v.to},
     missing:["savedEventsUnavailable"],agentId:"alex"};
   const result=v.cityEventId?
     await ctx.savedEvents(v.from,v.to,{cityEventId:v.cityEventId}):
     await ctx.savedEvents(v.from,v.to);
   const selectedCityEvent=v.cityEventId?
     result.cityCatalog?.items.find(e=>e.id===v.cityEventId)??null:null;
   return {source:"cafe_events",period:{from:v.from,to:v.to},
     missing:v.cityEventId&&!selectedCityEvent?["selectedCityEventNotFound"]:[],
     agentId:"alex",unit:"cents",events:[...result.events].sort((a,b)=>
       (a.startDate&&b.startDate?a.startDate.localeCompare(b.startDate):0)||
       Number(Boolean(b.lastVerifiedAt))-Number(Boolean(a.lastVerifiedAt)))
       .slice(0,8),
     ...(v.cityEventId?{selectedCityEvent,
       selectedCityEventId:v.cityEventId}:{}),
     // Same canonical saved read as Home; city catalog is paginated for screens.
     ...(result.cityCatalog?.available?{
       cityEvents:[...result.cityCatalog.items].sort((a,b)=>
         (a.startDate&&b.startDate?a.startDate.localeCompare(b.startDate):0)||
       Number(Boolean(b.lastVerifiedAt))-Number(Boolean(a.lastVerifiedAt))).slice(0,6),
       cityEventTotal:result.cityCatalog.total,
       cityEventPage:result.cityCatalog.page,
       omittedCityEvents:Math.max(0,result.cityCatalog.total-6),
     }:{}),
     ...(result.cityCoverage?{cityResearchCoverage:result.cityCoverage}:{}),
     ...(result.neighborhoodCoverage?.length?{
       neighborhoodResearchCoverage:result.neighborhoodCoverage}:{}),
     ...(result.neighborhood?.length?{
       neighborhood:result.neighborhood.slice(0,3).map(p=>({
         name:p.name,kind:p.kind,sourceUrl:p.sourceUrl,calendarUrl:p.calendarUrl,
         assessment:p.assessment,rationale:p.rationale,checkedAt:p.checkedAt})),
       omittedNeighborhood:Math.max(0,result.neighborhood.length-3),
     }:{}),
     plans:result.plans.slice(0,5).map(p=>({...p,report:compactReport(p.report)})),
     omittedEvents:Math.max(0,result.events.length-8),omittedPlans:Math.max(0,result.plans.length-5),
     searched:false,empty:result.events.length===0&&result.plans.length===0&&
       (!result.cityCatalog?.available||result.cityCatalog.total===0)};
  },
 },
} as const;
