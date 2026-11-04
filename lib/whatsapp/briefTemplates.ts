import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import type {ButtonPayload} from "./transport";

/** Approved (or proposed) Meta templates for the morning brief. The wording is
 * fixed by Meta; only blanks change. Which blank holds which fact, and which
 * quick-reply buttons go with it, lives here and nowhere else. */
export type BriefBlank=
  "cafe"|"netSales"|
  /** Current template: "☕ Drinks sold: {{3}}". */
  "drinksSold"|"bestSellerName"|"bestSellerUnits"|
  /** Proposed templates: "🧾 Sold: {{3}}" and "🏆 Best seller: {{4}}". */
  "soldLine"|"bestSellerLine"|
  "eventLine"|"weekdayNote";
export type BriefTemplate={
  name:string;language:"en_US";
  body:"whatsappTemplate"|"whatsappTemplateEvent"|"whatsappTemplateNoEvent";
  blanks:readonly BriefBlank[];buttons:readonly ButtonPayload[];
};

/** Approved and live today: 7 blanks, 4 buttons. */
export const CURRENT_TEMPLATE:BriefTemplate={name:"cafe_profit_daily_brief",language:"en_US",
  body:"whatsappTemplate",
  blanks:["cafe","netSales","drinksSold","bestSellerName","bestSellerUnits","eventLine","weekdayNote"],
  buttons:["money_went","peak_today","slowest_yesterday","event_today"]};
/** Proposed, not yet submitted to Meta: event today, 4 buttons. */
export const EVENT_TEMPLATE:BriefTemplate={name:"cafe_profit_brief_event",language:"en_US",
  body:"whatsappTemplateEvent",
  blanks:["cafe","netSales","soldLine","bestSellerLine","eventLine"],
  buttons:["money_went","peak_today","slowest_yesterday","event_today"]};
/** Proposed, not yet submitted to Meta: no event today, 3 buttons. */
export const NO_EVENT_TEMPLATE:BriefTemplate={name:"cafe_profit_brief_no_event",language:"en_US",
  body:"whatsappTemplateNoEvent",
  blanks:["cafe","netSales","soldLine","bestSellerLine","eventLine"],
  buttons:["money_went","peak_today","slowest_yesterday"]};
export const BRIEF_TEMPLATES:readonly BriefTemplate[]=[CURRENT_TEMPLATE,EVENT_TEMPLATE,NO_EVENT_TEMPLATE];

/** WHATSAPP_BRIEF_TEMPLATE_SET=split switches to the two proposed templates
 * once Meta approves them. Anything else (or unset) keeps the approved one. */
export function briefTemplateFor(eventToday:boolean,
  set:string|undefined=process.env.WHATSAPP_BRIEF_TEMPLATE_SET):BriefTemplate{
  if(set==="split")return eventToday?EVENT_TEMPLATE:NO_EVENT_TEMPLATE;
  return CURRENT_TEMPLATE;
}
export function templateByName(name:string|undefined):BriefTemplate|null{
  if(name===undefined)return CURRENT_TEMPLATE;
  return BRIEF_TEMPLATES.find(t=>t.name===name)??null;
}
/** The approved template text is also the website's owner-facing brief. */
export function renderBriefTemplate(template:BriefTemplate,fields:readonly string[],
  locale:"en"|"es"|"ar"="en"):string{
  // Single pass: "$&", "$$" and embedded "{{2}}" in café data stay literal.
  return ({en,es,ar} as const)[locale].DailyBrief[template.body].replace(/\{\{([1-9])\}\}/g,
    (match,index:string)=>fields[Number(index)-1]??match);
}
