/** Pure Meta payload validation. Never mix transport content with the Supervisor loop. */
export const TEST_PHONE_NUMBER_ID = "1322195347653883";
export const TEMPLATE = "cafe_profit_daily_brief";
export const BUTTONS = [
  {payload:"money_went",label:"Where did my money go?",question:"Where did my money go yesterday?"},
  {payload:"peak_today",label:"Peak hours today?",question:"What are my usual busiest hours for today?"},
  {payload:"slowest_yesterday",label:"Yesterday's slowest hour?",question:"What was my slowest hour yesterday?"},
  {payload:"event_today",label:"About today's event",question:"Tell me more about today's saved nearby event."},
] as const;
export type ButtonPayload = typeof BUTTONS[number]["payload"];
export type TemplateFields = readonly [string,string,string,string,string,string,string];
export type Outbound = {kind:"daily_brief";fields:TemplateFields}|{kind:"reply";text:string};
const phonePattern = /^[1-9][0-9]{7,14}$/;
const unsafe = /[\r\n\t\x00-\x1f\x7f<>*_~`]| {4,}/u;
export function normalizeRecipient(phone:string):string|null {
  const digits = phone.startsWith("+") ? phone.slice(1) : phone;
  return phonePattern.test(digits)?digits:null;
}
export function validTemplateFields(value:unknown):value is TemplateFields {
  return Array.isArray(value)&&value.length===7&&value.every(v=>
    typeof v==="string"&&v.length>=1&&v.length<=256&&
    v.trim()===v&&!unsafe.test(v));
}
export function validReply(text:unknown):text is string {
  return typeof text==="string"&&text.trim().length>0&&text.length<=4096&&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
export function buildOutbound(to:string, outbound:Outbound):Record<string,unknown>|null {
  const dest=normalizeRecipient(to);
  if (!dest) return null;
  if (outbound.kind==="reply") {
    if (!validReply(outbound.text)) return null;
    return {messaging_product:"whatsapp",to:dest,type:"text",text:{preview_url:false,body:outbound.text}};
  }
  if (!validTemplateFields(outbound.fields)) return null;
  return {messaging_product:"whatsapp",to:dest,type:"template",
    template:{name:TEMPLATE,language:{code:"en_US"},components:[
      {type:"body",parameters:outbound.fields.map(text=>({type:"text",text}))},
      ...BUTTONS.map((b,index)=>({type:"button",sub_type:"quick_reply",index:String(index),
        parameters:[{type:"payload",payload:b.payload}]})),
    ]}};
}
export function buttonQuestion(payload:string):string|null {
  return BUTTONS.find(b=>b.payload===payload)?.question??null;
}
