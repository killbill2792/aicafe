import Holidays from "date-holidays";

/** Public holidays and observances from maintained date-holidays data.
 * This is a calendar only: the AI interprets possible café effects. */

export type HolidayKind="public_holiday"|"observance"|"school";
export type HolidayDay={key:string;name:string;date:string;kind:HolidayKind;dayOff:boolean};

const KINDS:Record<string,HolidayKind|undefined>={public:"public_holiday",observance:"observance",optional:"observance",school:"school"};

let countries:Set<string>|null=null;
function supported(country:string):boolean{
  countries??=new Set(Object.keys(new Holidays().getCountries("en")));
  return countries.has(country);
}
const slug=(name:string)=>name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu,"_").replace(/^_|_$/gu,"");

/** Raw library rows for one year, English names (stable keys) zipped with the
 * owner's language (display). Unknown country → []. */
function yearRows(country:string,region:string|null,year:number,locale:string){
  if(!supported(country))return [];
  const lib=region?new Holidays(country,region):new Holidays(country);
  // Prefer the country's own variant of a language (en-us says "Labor Day", en says "Labour Day").
  const languages:string[]=lib.getLanguages()??[];
  const pick=(want:string)=>languages.find(l=>l===want||l.startsWith(want+"-"))??want;
  const en=lib.getHolidays(year,pick("en"))||[],shown=lib.getHolidays(year,pick(locale))||[];
  return en.map((h,i)=>({h,name:(shown[i]?.name??h.name)}));
}

/** Holidays from `from` to `to` (inclusive ISO dates) in the café's country/region. */
export function holidaysBetween(from:string,to:string,country:string|null,region:string|null=null,locale="en"):HolidayDay[]{
  if(!country||from>to)return [];
  const out:HolidayDay[]=[],seen=new Set<string>();
  for(let year=Number(from.slice(0,4));year<=Number(to.slice(0,4));year++){
    for(const {h,name} of yearRows(country,region,year,locale)){
      const kind=KINDS[h.type];
      const date=String(h.date).slice(0,10);
      if(!kind||date<from||date>to)continue;
      const englishName=h.name.replace(/\s*\(substitute day\)$/iu,"");
      const key=slug(englishName)+(h.substitute?"_observed":"");
      if(seen.has(key+date))continue;
      seen.add(key+date);
      out.push({key,name,date,kind,dayOff:kind==="public_holiday"});
    }
  }
  return out.sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key));
}

/** The same holiday in another year (for "how did it go last time"). */
export function holidayDateInYear(key:string,year:number,country:string|null,region:string|null=null):string|null{
  if(!country)return null;
  return holidaysBetween(year+"-01-01",year+"-12-31",country,region).find(h=>h.key===key)?.date??null;
}

/** Day of the week of an ISO date, 0 = Sunday. */
export function weekdayOf(date:string):number{return new Date(date+"T00:00:00Z").getUTCDay();}
export function addDays(date:string,days:number):string{
  const t=new Date(date+"T00:00:00Z");t.setUTCDate(t.getUTCDate()+days);return t.toISOString().slice(0,10);
}
export function daysBetween(from:string,to:string):number{
  return Math.round((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86_400_000);
}

const US_TIMEZONES=/^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Adak|Metlakatla|Yakutat|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+)$/u;
/** Country of the café: the saved profile country first, else a US-only timezone.
 * Shared zones (e.g. America/Toronto, Europe/*) are never guessed. */
export function cafeCountry(profileCountry:string|null|undefined,timezone:string|null|undefined):
  {country:string|null;source:"profile"|"timezone"|null}{
  const saved=profileCountry?.trim().toUpperCase();
  if(saved&&/^[A-Z]{2}$/u.test(saved))return {country:saved,source:"profile"};
  if(timezone&&US_TIMEZONES.test(timezone))return {country:"US",source:"timezone"};
  return {country:null,source:null};
}
