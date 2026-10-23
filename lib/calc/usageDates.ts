import {formatInTimeZone} from "date-fns-tz";
import {previousDate} from "./usageVariance";

/** Use the café's timezone, never the server's UTC calendar date. */
export function usageBusinessDay(now:Date,timezone:string):string{
 return formatInTimeZone(now,timezone,"yyyy-MM-dd");
}
export function usageWeekEnding(day:string):{from:string;to:string}{
 let from=day;
 for(let i=0;i<6;i++)from=previousDate(from);
 return {from,to:day};
}
