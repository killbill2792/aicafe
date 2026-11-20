import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

export const getEventsInput=z.strictObject({from:z.iso.date(),to:z.iso.date(),
 cityEventId:z.uuid().nullish(),cafeEventId:z.uuid().nullish()});
/** Keep chat tool evidence compact. Full readings remain in the one shared data reader. */
function compactReport(raw:unknown,from:string,to:string):Record<string,unknown>|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const r=raw as Record<string,unknown>;
 const days=Array.isArray(r.days)?r.days.filter(d=>d&&typeof d==="object").sort((a,b)=>{
   const inRange=(d:Record<string,unknown>)=>typeof d.date==="string"&&d.date>=from&&d.date<=to;
   return Number(inRange(b))-Number(inRange(a));
 }).slice(0,7)
   .map(d=>{const x=d as Record<string,unknown>;return {
     date:x.date,actualCents:x.actualCents,typicalCents:x.typicalCents,
     changePercent:x.changePercent,baselineDays:x.baselineDays};}):[];
 return {observedDays:r.observedDays??null,expectedDays:r.expectedDays??null,
   checklist:r.checklist??null,salesSummary:r.salesSummary??null,eventStatusDays:r.eventStatusDays??[],days,additionalDays:Array.isArray(r.days)?Math.max(0,r.days.length-days.length):0};
}
export const savedEventsTools={
 get_events:{
  agentId:"alex",
  schema:getEventsInput,
  description:"Read saved events, holidays, preparation decisions and reports (90-day range). Pass cafeEventId for [id:UUID] and cityEventId for [cityId:UUID] to resolve the exact tapped event and requested dates beyond compact lists. Missing is not absence. No web research or executed effects implied.",
  execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
   const v=getEventsInput.parse(raw);
   const ms=Date.parse(v.to+"T00:00:00Z")-Date.parse(v.from+"T00:00:00Z");
   if(v.from>v.to||ms>90*86400000)throw new Error("Invalid saved event range");
   if(!ctx.savedEvents)return {source:"cafe_events",period:{from:v.from,to:v.to},
     missing:["savedEventsUnavailable"],agentId:"alex"};
   const exactOptions={...(v.cityEventId?{cityEventId:v.cityEventId}:{}),
     ...(v.cafeEventId?{cafeEventId:v.cafeEventId}:{})};
   const result=v.cityEventId||v.cafeEventId?
     await ctx.savedEvents(v.from,v.to,exactOptions):
     await ctx.savedEvents(v.from,v.to);
   const selectedCityEvent=v.cityEventId?
     result.cityCatalog?.items.find(e=>e.id===v.cityEventId)??null:null;
   const selectedId=v.cafeEventId??selectedCityEvent?.cafeEventId;
   const selectedCafeEvent=selectedId?(result.selectedCafeEvent?.id===selectedId?result.selectedCafeEvent:
     result.events.find(e=>e.id===selectedId)??null):null;
   const exactMismatch=Boolean(v.cafeEventId&&v.cityEventId&&selectedCityEvent?.cafeEventId!==v.cafeEventId);
   const exactRequested=Boolean(v.cafeEventId||v.cityEventId);
   const relevantPlans=exactRequested?(selectedCafeEvent&&!exactMismatch?
     result.plans.filter(p=>p.eventIds?.includes(selectedCafeEvent.id)):[]):result.plans;
   return {source:"cafe_events",period:{from:v.from,to:v.to},
     missing:[...(v.cityEventId&&!selectedCityEvent?["selectedCityEventNotFound"]:[]),
       ...(v.cafeEventId&&!selectedCafeEvent?["selectedCafeEventNotFound"]:[]),
       ...(exactMismatch?["selectedEventIdentityMismatch"]:[])],
     ...(exactRequested?{selectedCafeEvent:exactMismatch?null:selectedCafeEvent}:{}),
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
     plans:relevantPlans.slice(0,5).map(p=>({...p,report:compactReport(p.report,v.from,v.to)})),
     omittedEvents:Math.max(0,result.events.length-8),omittedPlans:Math.max(0,relevantPlans.length-5),
     searched:false,empty:result.events.length===0&&result.plans.length===0&&
       (!result.cityCatalog?.available||result.cityCatalog.total===0)};
  },
 },
} as const;
