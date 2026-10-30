/** Public holidays and café-relevant observances, worked out in code (no outside
 * service). Today only the United States list is built in; other countries get
 * their holidays from the nearby-events web search instead. Dates are ISO
 * YYYY-MM-DD in the café's own calendar. */

export type HolidayKind="public_holiday"|"observance";
/** General pattern for cafés, NOT this café's data. The café's own past sales win. */
export type UsualEffect="busier"|"quieter"|"varies";
export type HolidayDay={key:string;name:string;date:string;kind:HolidayKind;usualEffect:UsualEffect;why:string};

type Rule={key:string;name:string;kind:HolidayKind;usualEffect:UsualEffect;why:string;date:(year:number)=>string;observed?:boolean};

const pad=(n:number)=>String(n).padStart(2,"0");
const iso=(y:number,m:number,d:number)=>y+"-"+pad(m)+"-"+pad(d);
/** Weekday of an ISO date, 0 = Sunday. */
export function weekdayOf(date:string):number{return new Date(date+"T00:00:00Z").getUTCDay();}
export function addDays(date:string,days:number):string{
  const t=new Date(date+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+days);return t.toISOString().slice(0,10);
}
/** The nth (1-based) weekday of a month; weekday 0 = Sunday. */
function nthWeekday(year:number,month:number,weekday:number,n:number):string{
  const first=weekdayOf(iso(year,month,1));
  return iso(year,month,1+((weekday-first+7)%7)+(n-1)*7);
}
function lastWeekday(year:number,month:number,weekday:number):string{
  const days=new Date(Date.UTC(year,month,0)).getUTCDate();
  const last=weekdayOf(iso(year,month,days));
  return iso(year,month,days-((last-weekday+7)%7));
}
/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(year:number):string{
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  return iso(year,Math.floor((h+l-7*m+114)/31),((h+l-7*m+114)%31)+1);
}
const OFFICES_CLOSED="Offices, banks and schools closed. Cafés near offices or commuter routes are often quieter; neighborhood, park and shopping-area cafés are often busier. Long weekend: some regulars travel.";

const US:Rule[]=[
  {key:"new_years_day",name:"New Year's Day",kind:"public_holiday",usualEffect:"quieter",observed:true,
    why:"Late night before; mornings are slow, afternoons pick up. Many businesses closed.",date:y=>iso(y,1,1)},
  {key:"mlk_day",name:"Martin Luther King Jr. Day",kind:"public_holiday",usualEffect:"varies",why:OFFICES_CLOSED,date:y=>nthWeekday(y,1,1,3)},
  {key:"valentines_day",name:"Valentine's Day",kind:"observance",usualEffect:"busier",
    why:"Treats, pastries and gift cards sell more; couples and friends meet for coffee.",date:y=>iso(y,2,14)},
  {key:"presidents_day",name:"Presidents' Day",kind:"public_holiday",usualEffect:"varies",why:OFFICES_CLOSED,date:y=>nthWeekday(y,2,1,3)},
  {key:"st_patricks_day",name:"St. Patrick's Day",kind:"observance",usualEffect:"varies",
    why:"Parades and evening crowds in some cities; daytime is usually normal.",date:y=>iso(y,3,17)},
  {key:"easter",name:"Easter Sunday",kind:"observance",usualEffect:"varies",
    why:"Morning church and brunch crowds in some areas; many families stay home in the afternoon.",date:easter},
  {key:"mothers_day",name:"Mother's Day",kind:"observance",usualEffect:"busier",
    why:"One of the busiest brunch and treat days; families go out in the morning.",date:y=>nthWeekday(y,5,0,2)},
  {key:"memorial_day",name:"Memorial Day",kind:"public_holiday",usualEffect:"varies",why:OFFICES_CLOSED+" Start of summer.",date:y=>lastWeekday(y,5,1)},
  {key:"fathers_day",name:"Father's Day",kind:"observance",usualEffect:"busier",
    why:"Families go out for breakfast and treats.",date:y=>nthWeekday(y,6,0,3)},
  {key:"juneteenth",name:"Juneteenth",kind:"public_holiday",usualEffect:"varies",observed:true,why:OFFICES_CLOSED,date:y=>iso(y,6,19)},
  {key:"independence_day",name:"Independence Day",kind:"public_holiday",usualEffect:"varies",observed:true,
    why:"Parades and fireworks: busy near event areas, quiet in office areas. Many people travel.",date:y=>iso(y,7,4)},
  {key:"labor_day",name:"Labor Day",kind:"public_holiday",usualEffect:"varies",why:OFFICES_CLOSED+" Last summer long weekend.",date:y=>nthWeekday(y,9,1,1)},
  {key:"national_coffee_day",name:"National Coffee Day",kind:"observance",usualEffect:"busier",
    why:"Coffee deals and social media posts bring extra coffee customers.",date:y=>iso(y,9,29)},
  {key:"indigenous_peoples_day",name:"Columbus Day / Indigenous Peoples' Day",kind:"public_holiday",usualEffect:"varies",
    why:"Banks, government offices and some schools closed; most businesses open.",date:y=>nthWeekday(y,10,1,2)},
  {key:"halloween",name:"Halloween",kind:"observance",usualEffect:"varies",
    why:"Trick-or-treating in the late afternoon and evening; families and costume parties are out. Busier in residential and downtown areas, especially on a weekend. Seasonal drinks (pumpkin spice) and treats sell more. Evening can be quiet once people go home to hand out candy.",
    date:y=>iso(y,10,31)},
  {key:"veterans_day",name:"Veterans Day",kind:"public_holiday",usualEffect:"varies",observed:true,
    why:"Banks, government offices and some schools closed; most businesses open.",date:y=>iso(y,11,11)},
  {key:"thanksgiving",name:"Thanksgiving",kind:"public_holiday",usualEffect:"quieter",
    why:"Most people are at home with family; early morning may be busy with travelers, then very quiet.",date:y=>nthWeekday(y,11,4,4)},
  {key:"black_friday",name:"Black Friday",kind:"observance",usualEffect:"varies",
    why:"Shoppers out early: busy near shopping areas, quiet near offices.",date:y=>addDays(nthWeekday(y,11,4,4),1)},
  {key:"christmas_eve",name:"Christmas Eve",kind:"observance",usualEffect:"varies",
    why:"Busy last-minute morning (gift cards, treats); very quiet by afternoon.",date:y=>iso(y,12,24)},
  {key:"christmas_day",name:"Christmas Day",kind:"public_holiday",usualEffect:"quieter",observed:true,
    why:"Most people are at home; many cafés close.",date:y=>iso(y,12,25)},
  {key:"new_years_eve",name:"New Year's Eve",kind:"observance",usualEffect:"varies",
    why:"Normal or quiet daytime; people go out in the evening.",date:y=>iso(y,12,31)},
];

/** US federal rule: a Saturday holiday is observed on Friday, a Sunday one on Monday. */
function observedDate(date:string):string|null{
  const w=weekdayOf(date);
  return w===6?addDays(date,-1):w===0?addDays(date,1):null;
}

/** Countries with a built-in holiday list. */
export const BUILT_IN_HOLIDAY_COUNTRIES=["US"] as const;
const US_TIMEZONES=/^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Adak|Metlakatla|Yakutat|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+)$/u;

/** Country of the café: the saved profile country first, else a US-only timezone. */
export function cafeCountry(profileCountry:string|null|undefined,timezone:string|null|undefined):
  {country:string|null;source:"profile"|"timezone"|null}{
  const saved=profileCountry?.trim().toUpperCase();
  if(saved&&/^[A-Z]{2}$/u.test(saved))return {country:saved,source:"profile"};
  if(timezone&&US_TIMEZONES.test(timezone))return {country:"US",source:"timezone"};
  return {country:null,source:null};
}

/** Holidays and observances from `from` to `to` (inclusive, ISO dates). An
 * unsupported or unknown country returns [] — never another country's list. */
export function holidaysBetween(from:string,to:string,country:string|null):HolidayDay[]{
  if(country!=="US"||from>to)return [];
  const out:HolidayDay[]=[];
  for(let year=Number(from.slice(0,4));year<=Number(to.slice(0,4));year++){
    for(const rule of US){
      const date=rule.date(year);
      const base={key:rule.key,name:rule.name,kind:rule.kind,usualEffect:rule.usualEffect,why:rule.why};
      if(date>=from&&date<=to)out.push({...base,date});
      const observed=rule.observed?observedDate(date):null;
      if(observed&&observed>=from&&observed<=to)
        out.push({...base,key:rule.key+"_observed",name:rule.name+" (observed)",date:observed,
          why:"Day off for "+rule.name+", which falls on a weekend. "+OFFICES_CLOSED});
    }
  }
  return out.sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key));
}

/** The same holiday's date in an earlier year (for "what happened last time"). */
export function holidayDateInYear(key:string,year:number):string|null{
  const observed=key.endsWith("_observed");
  const rule=US.find(r=>r.key===(observed?key.slice(0,-"_observed".length):key));
  if(!rule)return null;
  const date=rule.date(year);
  return observed?observedDate(date):date;
}
