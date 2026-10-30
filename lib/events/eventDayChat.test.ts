import {describe,expect,it} from "vitest";
import {eventDayChatContext} from "./eventDayChat";
import type {EventsOutlook,OutlookDay} from "./outlook";

const day={date:"2026-10-31",weekday:"Saturday",daysFromToday:1,
  holidays:[{key:"halloween",name:"Halloween",date:"2026-10-31",kind:"observance" as const,dayOff:false}],
  eventIds:["e1"],typicalSalesCents:150000,typicalSampleDays:5,lastTime:null,
  usualHourlySales:[]} satisfies OutlookDay;
const outlook={
  from:"2026-10-30",to:"2026-11-05",today:"2026-10-30",location:null,country:"US",countrySource:"profile",
  days:[day],localEvents:[{id:"e1",name:"Neighborhood parade",startDate:"2026-10-31",endDate:"2026-10-31",
    venue:"Main Street",distance:null,kind:"parade" as const,expectedCrowd:"unknown" as const,
    sourceUrl:"https://city.example.org/parade",sourceName:"City"}],
  localEventsSearched:true,notCovered:[],addressMissing:false,hourlySalesQuality:null,
} satisfies EventsOutlook;

describe("event day chat context",()=>{
  it("carries the selected event, date, venue and source into its own chat without staffing advice",()=>{
    const context=JSON.parse(eventDayChatContext(day,outlook));
    expect(context).toEqual({date:"2026-10-31",holidays:[{name:"Halloween",kind:"observance"}],
      events:[{name:"Neighborhood parade",startDate:"2026-10-31",endDate:"2026-10-31",
        venue:"Main Street",sourceUrl:"https://city.example.org/parade"}],
      usualSalesAvailable:true,pastHolidaySalesAvailable:false});
    expect(JSON.stringify(context)).not.toContain("add_staff");
    expect(JSON.stringify(context)).not.toContain("150000");
  });
  it("does not manufacture event facts or sales when no event is linked",()=>{
    expect(JSON.parse(eventDayChatContext({...day,eventIds:["missing"],typicalSalesCents:null},outlook)))
      .toMatchObject({events:[],usualSalesAvailable:false});
  });
});
