import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {formatCafeCurrency} from "@/lib/format/cafeCurrency";
import {addCalendarDays} from "@/lib/pos/toast/scheduleDates";
import type {CafeEvent} from "@/lib/data/cafeEvents.server";
import {validTemplateFields} from "./transport";
import {renderBriefTemplate,type BriefBlank,type BriefTemplate} from "./briefTemplates";

/** The morning brief's content (AGENTS.md §4c). It never fails on a missing
 * extra: net sales, items sold, best seller and one event line are always
 * filled, each saying plainly what is not in yet. Only a day with truly nothing
 * to say (no sales, no items and no event information) is skipped.
 * No provider calls, search, finance calculation or notification state here. */
export type MorningBriefEvidence={
  businessName:string;currency:string|null;today:string;yesterday:string;
  /** Yesterday's certified net sales (daily_rollups, status "actual"), or null. */
  netSalesCents:number|null;
  sold:{available:boolean;linked:readonly {id:string;units:number}[];
    unlinked:readonly {name:string;category:string|null;units:number}[]};
  menu:readonly {id:string;name:string;base_name:string|null;category:string}[];
  /** Saved drink / not-drink label per café menu category (menu_category_labels). */
  categoryLabels:ReadonlyMap<string,boolean>;
  /** Events from today through 7 days ahead, from the one canonical Events reader.
   * available=false: the reader failed. coverage: city research status for the week. */
  events:{available:boolean;items:readonly CafeEvent[];
    coverage:"complete"|"partial"|"unsearched"|"unavailable"|null};
};
export type ItemsMode="drinks"|"all_items"|"unavailable";
export type EventKind="today"|"next"|"none"|"none_unconfirmed"|"unavailable";
export type BriefLocale="en"|"es"|"ar";
export type BriefContent={
  /** WhatsApp templates are English; the in-app brief uses the owner's language. */
  locale:BriefLocale;
  cafe:string;today:string;yesterday:string;weekday:string;
  netSales:{known:boolean;cents:number|null;text:string;currencyMissing:boolean};
  items:{mode:ItemsMode;total:number|null;drinks:number|null;best:{name:string;units:number}|null};
  event:{kind:EventKind;line:string;eventId:string|null;verified:boolean|null};
  /** False only when there is truly nothing to say. */
  hasSomethingToSay:boolean;
  /** What is missing, for the skip record and the admin page. */
  missing:string[];
};
export type PreparedMorningBrief={
  template:BriefTemplate;fields:string[];
  netSalesCents:number|null;businessDate:string;today:string;
  provenance:{sales:"daily_rollups";items:"menu_item_quantities_sold+order_lines";menu:"menu_items";
    itemsMode:ItemsMode;eventKind:EventKind;eventId:string|null};
};

const copies={en:en.DailyBrief.blanks,es:es.DailyBrief.blanks,ar:ar.DailyBrief.blanks} as const;
type Copy=typeof en.DailyBrief.blanks;
/** The app's own menu category codes (manual and CSV menus). A POS category,
 * named by the café, is labeled once by the AI (lib/menu/drinkLabels.server.ts). */
export const APP_MENU_DRINK_CATEGORIES:ReadonlySet<string>=
  new Set(["ESPRESSO_DRINK","BREWED_COFFEE","COLD_BREW","TEA","SPECIALTY_DRINK","drink"]);
export const APP_MENU_OTHER_CATEGORIES:ReadonlySet<string>=new Set(["PASTRY","FOOD","RETAIL","food"]);
/** true = drink, false = not a drink, null = not labeled yet. */
export function isDrinkCategory(category:string|null,labels:ReadonlyMap<string,boolean>):boolean|null{
  if(!category)return null;
  if(APP_MENU_DRINK_CATEGORIES.has(category))return true;
  if(APP_MENU_OTHER_CATEGORIES.has(category))return false;
  const label=labels.get(category.trim());
  return label===undefined?null:label;
}
/** Meta rejects line breaks, tabs and 4+ spaces; markup would change the message. */
export function safeText(value:string,max=160):string{
  const s=Array.from(value,ch=>{
    const code=ch.codePointAt(0)??0;
    return code<32||code===127?" ":ch;
  }).join("").replace(/[\\*_~`<>]/g,"").replace(/\s+/g," ").trim();
  if(s.length<=max)return s;
  const cut=s.slice(0,max-1),space=cut.lastIndexOf(" ");
  return (space>max/2?cut.slice(0,space):cut).trimEnd()+"…";
}
const fill=(text:string,values:Record<string,string>)=>
  text.replace(/\{(\w+)\}/g,(match,key:string)=>values[key]??match);
const count=(n:number,locale:BriefLocale)=>new Intl.NumberFormat(locale==="en"?"en-US":locale,
  {maximumFractionDigits:2}).format(n);
const weekdayOf=(day:string,locale:BriefLocale)=>new Intl.DateTimeFormat(locale==="en"?"en-US":locale,
  {weekday:"long",timeZone:"UTC"}).format(new Date(day+"T12:00:00Z"));
const VERIFIED_FOR_MS=72*60*60*1000;

/** Verification only softens the wording; it never hides an event. */
export function eventVerified(e:CafeEvent,now:Date):boolean{
  if(!e.lastVerifiedAt)return false;
  const at=Date.parse(e.lastVerifiedAt);
  if(!Number.isFinite(at)||at>now.getTime()||now.getTime()-at>VERIFIED_FOR_MS)return false;
  if(e.verificationFailedAt&&Date.parse(e.verificationFailedAt)>at)return false;
  return e.kind==="holiday"||Boolean(e.sourceUrl&&/^https:\/\//i.test(e.sourceUrl));
}
function eventText(e:CafeEvent,copy:Copy):string{
  const time=e.startTime&&/^([01]\d|2[0-3]):[0-5]\d/.test(e.startTime)?e.startTime.slice(0,5):null;
  const venue=e.venue?safeText(e.venue,65):"";
  return safeText(e.name,90)+(venue?fill(copy.eventVenue,{venue}):"")+(time?fill(copy.eventTime,{time}):"");
}
const byStart=(a:CafeEvent,b:CafeEvent)=>a.startDate.localeCompare(b.startDate)||
  (a.startTime??"99:99").localeCompare(b.startTime??"99:99")||a.id.localeCompare(b.id);

function eventLine(e:MorningBriefEvidence,now:Date,copy:Copy,locale:BriefLocale):BriefContent["event"]{
  if(!e.events.available)return {kind:"unavailable",line:copy.eventsUnavailable,eventId:null,verified:null};
  const live=e.events.items.filter(x=>x.status==="found"&&safeText(x.name,90));
  const today=live.filter(x=>x.startDate<=e.today&&x.endDate>=e.today).sort(byStart)[0];
  if(today){
    const verified=eventVerified(today,now),text=eventText(today,copy);
    return {kind:"today",eventId:today.id,verified,
      line:verified?text:fill(copy.eventUnconfirmed,{event:text})};
  }
  const horizon=addCalendarDays(e.today,7);
  const next=live.filter(x=>x.startDate>e.today&&x.startDate<=horizon).sort(byStart)[0];
  if(next){
    const distance=next.areaLabel?safeText(next.areaLabel,40):"";
    const verified=eventVerified(next,now),text=eventText(next,copy);
    const values={event:verified?text:fill(copy.eventUnconfirmed,{event:text}),
      day:weekdayOf(next.startDate,locale),distance};
    return {kind:"next",eventId:next.id,verified,
      line:fill(distance?copy.nextEventDistance:copy.nextEvent,values)};
  }
  // "None" is said only when this week's research actually completed.
  return e.events.coverage==="complete"
    ?{kind:"none",line:copy.noEventsWeek,eventId:null,verified:null}
    :{kind:"none_unconfirmed",line:copy.noConfirmedEvents,eventId:null,verified:null};
}

function itemsSold(e:MorningBriefEvidence,copy:Copy):BriefContent["items"]{
  if(!e.sold.available)return {mode:"unavailable",total:null,drinks:null,best:null};
  const menu=new Map(e.menu.map(item=>[item.id,item]));
  const lines=[
    ...e.sold.linked.map(s=>{
      const item=menu.get(s.id);
      return {name:item?safeText(item.base_name?.trim()||item.name,120):copy.unknownItem,
        category:item?.category??null,units:s.units};
    }),
    ...e.sold.unlinked.map(s=>({name:safeText(s.name,120),category:s.category,units:s.units})),
  ].filter(l=>Number.isFinite(l.units)&&l.units>0&&l.name);
  if(!lines.length)return {mode:"unavailable",total:null,drinks:null,best:null};
  const best=(rows:typeof lines)=>{
    const totals=new Map<string,number>();
    for(const r of rows)totals.set(r.name,(totals.get(r.name)??0)+r.units);
    const [name,units]=[...totals].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]??[];
    return name===undefined?null:{name,units:units as number};
  };
  const total=lines.reduce((sum,l)=>sum+l.units,0);
  // Drink-only counts only when every category sold yesterday is labeled.
  const labeled=lines.map(l=>({...l,drink:isDrinkCategory(l.category,e.categoryLabels)}));
  if(labeled.every(l=>l.drink!==null)){
    const drinks=labeled.filter(l=>l.drink);
    if(drinks.length)return {mode:"drinks",total,
      drinks:drinks.reduce((sum,l)=>sum+l.units,0),best:best(drinks)};
  }
  return {mode:"all_items",total,drinks:null,best:best(lines)};
}

export function buildBriefContent(e:MorningBriefEvidence,now:Date,locale:BriefLocale="en"):BriefContent{
  const copy=copies[locale];
  const missing:string[]=[];
  const known=e.netSalesCents!==null&&Number.isSafeInteger(e.netSalesCents);
  let netSales:BriefContent["netSales"];
  if(known){
    const money=formatCafeCurrency(e.netSalesCents as number,locale,e.currency);
    if(money.currencyMissing)missing.push("currency_not_set");
    netSales={known:true,cents:e.netSalesCents,currencyMissing:money.currencyMissing,
      text:money.currencyMissing?fill(copy.currencyNotSet,{amount:money.text}):money.text};
  }else{
    missing.push("sales_not_in");
    netSales={known:false,cents:null,currencyMissing:false,text:copy.salesNotIn};
  }
  const items=itemsSold(e,copy);
  if(items.mode==="unavailable")missing.push("items_not_in");
  if(items.mode==="all_items")missing.push("drink_labels_incomplete");
  const event=eventLine(e,now,copy,locale);
  if(event.kind==="unavailable")missing.push("events_unavailable");
  if(event.kind==="none_unconfirmed")missing.push("event_research_incomplete");
  const cafe=safeText(e.businessName,120)||copy.cafeFallback;
  return {locale,cafe,today:e.today,yesterday:e.yesterday,weekday:weekdayOf(e.today,locale),netSales,items,event,
    hasSomethingToSay:netSales.known||items.mode!=="unavailable"||
      event.kind==="today"||event.kind==="next"||event.kind==="none",
    missing};
}

function blankValue(c:BriefContent,blank:BriefBlank):string{
  const i=c.items,copy=copies[c.locale],num=(n:number)=>count(n,c.locale);
  switch(blank){
    case "cafe":return c.cafe;
    case "netSales":return c.netSales.text;
    case "drinksSold":return i.mode==="drinks"?num(i.drinks as number):
      i.mode==="all_items"?fill(copy.allItemsCurrent,{items:num(i.total as number)}):copy.itemsNotIn;
    case "bestSellerName":return i.best?.name??copy.bestNotIn;
    case "bestSellerUnits":return i.best?num(i.best.units):copy.bestUnitsNotIn;
    case "soldLine":return i.mode==="drinks"?
      fill(copy.itemsWithDrinks,{drinks:num(i.drinks as number),items:num(i.total as number)}):
      i.mode==="all_items"?fill(copy.itemsAll,{items:num(i.total as number)}):copy.itemsNotIn;
    case "bestSellerLine":return i.best?
      fill(copy.bestLine,{name:i.best.name,units:num(i.best.units)}):copy.bestNotIn;
    case "eventLine":return c.event.line;
    case "weekdayNote":return fill(copy.weekdayNote,{weekday:c.weekday});
  }
}
/** Ordered blanks for one template. Never empty, never a line break. */
export function briefTemplateFields(c:BriefContent,template:BriefTemplate):string[]{
  return template.blanks.map(blank=>safeText(blankValue(c,blank),240)||"—");
}
export function prepareMorningBrief(c:BriefContent,template:BriefTemplate):PreparedMorningBrief|null{
  const fields=briefTemplateFields(c,template);
  if(!validTemplateFields(fields,template.blanks.length))return null;
  return {template,fields,netSalesCents:c.netSales.cents,businessDate:c.yesterday,today:c.today,
    provenance:{sales:"daily_rollups",items:"menu_item_quantities_sold+order_lines",menu:"menu_items",
      itemsMode:c.items.mode,eventKind:c.event.kind,eventId:c.event.eventId}};
}
export function renderMorningBrief(p:Pick<PreparedMorningBrief,"template"|"fields">,locale:BriefLocale="en"):string{
  return renderBriefTemplate(p.template,p.fields,locale);
}
