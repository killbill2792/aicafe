import {fromZonedTime} from "date-fns-tz";
import {addCalendarDays,localClock} from "@/lib/pos/toast/scheduleDates";
import {OPEN_HOURS_DAY_KEYS,type OpenHours} from "@/lib/business/openHours";

/** When each café's morning brief goes out (AGENTS.md §4c).
 *
 * - Latest send time: 30 minutes before that day's first opening time.
 * - Send as soon as yesterday's POS data is complete, but not earlier than
 *   3 hours before the latest send time (and never before 04:00 café time).
 * - From 15 minutes before the latest send time, send anyway with what we have.
 * - If the cron missed that, still send until the café opens (marked late).
 * - Unknown or unusable hours: the café is treated as opening at 06:30, so the
 *   latest send time is 06:00 café time; the reason is recorded.
 */
export const DEFAULT_OPEN_MINUTE=6*60+30;
export const LEAD_MINUTES=30;
export const EARLIEST_LEAD_MINUTES=3*60;
export const NEVER_BEFORE_MINUTE=4*60;
export const FALLBACK_LEAD_MINUTES=15;
/** Opening times this early (24-hour cafés, overnight hours) use the default. */
const EARLIEST_USABLE_OPEN=4*60+30;
/** A missed brief is still recorded for two hours after opening, then left alone. */
export const MISSED_RECORD_MINUTES=2*60;

export type HoursSource="open_hours"|"default_unknown_hours"|"default_closed_today"|
  "default_overnight_hours";
export type BriefPhase=
  /** Too early: nothing to do yet. */
  "early"|
  /** Send if yesterday's data is complete, otherwise wait. */
  "window"|
  /** Latest send time is close: send now with what we have. */
  "fallback"|
  /** Past the latest send time but before opening: send now, marked late. */
  "late"|
  /** The café has opened: today's brief was missed. */
  "missed"|
  /** Long after opening: nothing to do or record. */
  "done";
export type BriefSchedule={
  today:string;yesterday:string;timezone:string;nowMinute:number;
  openMinute:number;latestMinute:number;earliestMinute:number;fallbackMinute:number;
  hoursSource:HoursSource;phase:BriefPhase;
  /** The outbox deadline: the café's opening time today, as an instant. */
  sendBefore:string;
  /** "06:00" style, for records and the admin page. */
  latestSendLocal:string;
};

const hhmm=(minutes:number)=>String(Math.floor(minutes/60)).padStart(2,"0")+":"+
  String(minutes%60).padStart(2,"0");
const toMinutes=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5));

/** The first opening time on a café-local date, or why we fell back to the default. */
export function openingMinute(openHours:OpenHours|null,day:string):{minute:number;source:HoursSource}{
  if(!openHours)return {minute:DEFAULT_OPEN_MINUTE,source:"default_unknown_hours"};
  const [y,m,d]=day.split("-").map(Number);
  const key=OPEN_HOURS_DAY_KEYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
  if(!Object.prototype.hasOwnProperty.call(openHours,key))
    return {minute:DEFAULT_OPEN_MINUTE,source:"default_unknown_hours"};
  const intervals=openHours[key]??[];
  if(!intervals.length)return {minute:DEFAULT_OPEN_MINUTE,source:"default_closed_today"};
  const first=Math.min(...intervals.map(([open])=>toMinutes(open)));
  if(first<EARLIEST_USABLE_OPEN)return {minute:DEFAULT_OPEN_MINUTE,source:"default_overnight_hours"};
  return {minute:first,source:"open_hours"};
}

/** Throws only for an invalid IANA timezone. */
export function briefSchedule(now:Date,timezone:string,openHours:OpenHours|null):BriefSchedule{
  const clock=localClock(now,timezone);
  const open=openingMinute(openHours,clock.today);
  const latest=open.minute-LEAD_MINUTES;
  const earliest=Math.min(latest,Math.max(NEVER_BEFORE_MINUTE,latest-EARLIEST_LEAD_MINUTES));
  const fallback=Math.max(earliest,latest-FALLBACK_LEAD_MINUTES);
  const m=clock.minutes;
  const phase:BriefPhase=m<earliest?"early":m<fallback?"window":m<latest?"fallback":
    m<open.minute?"late":m<open.minute+MISSED_RECORD_MINUTES?"missed":"done";
  const sendBefore=fromZonedTime(clock.today+"T"+hhmm(open.minute)+":00",timezone);
  return {today:clock.today,yesterday:addCalendarDays(clock.today,-1),timezone,nowMinute:m,
    openMinute:open.minute,latestMinute:latest,earliestMinute:earliest,fallbackMinute:fallback,
    hoursSource:open.source,phase,sendBefore:sendBefore.toISOString(),latestSendLocal:hhmm(latest)};
}
