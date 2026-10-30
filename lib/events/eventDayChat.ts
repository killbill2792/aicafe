import type {EventsOutlook,OutlookDay} from "./outlook";

/** Event-day facts already visible on Home. Never copy hard-coded staffing advice.
 * The Supervisor can refresh details with get_nearby_events and web_search. */
export function eventDayChatContext(day:OutlookDay,outlook:EventsOutlook):string{
  const events=day.eventIds.flatMap(id=>{
    const event=outlook.localEvents.find(e=>e.id===id);
    return event?[{name:event.name,startDate:event.startDate,endDate:event.endDate,
      venue:event.venue,sourceUrl:event.sourceUrl}]:[];
  });
  return JSON.stringify({
    date:day.date,
    holidays:day.holidays.map(h=>({name:h.name,kind:h.kind})),
    events,
    usualSalesAvailable:day.typicalSalesCents!==null,
    pastHolidaySalesAvailable:day.lastTime!==null,
  });
}
