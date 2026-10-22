/** Narrow, deterministic publication boundary for native AI explanations.
 * The model chooses its words. We preserve them, verifying numerical spans
 * against the actual selected source values, issued choices and owner request.
 * This does not authorize any business effect or assert semantic proof of prose.
 */
import {NUMERIC_SPAN} from "./formulaVerification";
export type OwnerLocale="en"|"es"|"ar";
const token=new RegExp(NUMERIC_SPAN,"giu");
const sourceNumber=(s:string)=>[...s.matchAll(token)].map(m=>m[0]);
const words={
 en:{unknown:"a value I couldn't verify",action:"I haven't verified that the requested action was completed."},
 es:{unknown:"un valor que no pude verificar",action:"No he verificado que la acción solicitada se haya completado."},
 ar:{unknown:"قيمة لم أتمكن من التحقق منها",action:"لم أتحقق من اكتمال الإجراء المطلوب."},
};
const normalize=(s:string)=>s.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu," ").trim();
function category(span:string,following:string){
 const combined=normalize(span+" "+following.slice(0,18));
 if(/[%٪]/u.test(span))return "percent";
 if(/[$€£¥]|\b(?:dollars?|d[oó]lares?|usd|cents?|centavos?)\b|(?:دولار|سنت)/iu.test(span))
   return "money";
 if(/\b(?:oz|ounces?|ml|kg|lbs?|cl|pt|qt|gal)\b/iu.test(combined))return "size";
 return "plain";
}
function magnitude(span:string):string{
 const number=span.match(/[\p{Nd}]+(?:[.,٫٬][\p{Nd}]+)*/u)?.[0]??"";
 return number.replace(/,/gu,"").replace(/٫/gu,".").replace(/٬/gu,"");
}
function authorized(source:string):{amount:string;kind:string}[]{
 return [...source.matchAll(token)].map(m=>({
   amount:magnitude(m[0]),kind:category(m[0],source.slice(m.index+m[0].length)),
 }));
}
function approved(span:string,after:string,known:readonly string[]):boolean{
 const n=magnitude(span),kind=category(span,after);
 return known.some(source=>authorized(source).some(item=>
   item.amount===n&&item.kind===kind));
}
/** Numbers are permitted in *natural* model text when sourced; unsupported
 * spans are redacted locally, never replaced by a generic question.
 * Model-authored claims of completed side effects are never authorized by
 * a read-only source.
 */
export function groundedNaturalProse(text:string,known:readonly string[],locale:OwnerLocale,
 opts:{allowActionCompletion?:boolean}={}):{text:string;redacted:boolean}{
 const raw=text.replace(/[\p{Cc}\p{Cf}]/gu," ").trim().slice(0,1200);
 let redacted=false;
 const checked=raw.replace(token,(span:string,offset:number,whole:string)=>{
   if(approved(span,whole.slice(offset+span.length),known))return span;
   redacted=true;return words[locale].unknown;
 });
 if(opts.allowActionCompletion)return {text:checked,redacted};
 // Block affirmative completion assertions unless their fulfillment came
 // from a verified action path (handled separately, never model prose).
 const claims=[
   /\b(?:I|we|the system|supervisor)\s+(?:have\s+)?(?:published|sent|changed|updated|approved|committed|completed|scheduled|executed|submitted|deleted|paid|placed the order)\b/iu,
   /\b(?:he|hemos|ya)\s+(?:publicado|enviado|cambiado|actualizado|aprobado|completado|pagado|programado)\b/iu,
   /(?:لقد|تم|قمنا)\s*(?:نشر|إرسال|تغيير|تحديث|اعتماد|دفع|تنفيذ|جدولة)/u,
 ];
 const sentences=checked.split(/(?<=[.!?؟])\s+/u);
 const filtered=sentences.map(sentence=>{
   if(claims.some(pattern=>pattern.test(sentence))){
     redacted=true;return words[locale].action;
   }
   return sentence;
 });
 return {text:filtered.join(" "),redacted};
}
