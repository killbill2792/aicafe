/** Shared UTF-16-offset tokenizer for both grounding and chat provenance.
 * Monetary values are integer cents; percentages are basis points. */
export type NumberLocale="en"|"es"|"ar";
export type NumberTokenKind="money"|"percent"|"count"|"decimal"|"clock"|"clockRange"|"date"|"dateRange"|"duration"|"range"|"ordinal"|"phone/id";
export type NumberToken={start:number;end:number;kind:NumberTokenKind;value:number|null;unit:string|null};
const D="[0-9٠-٩۰-۹]";
const currency="(?:US\\$|[$€£]|USD|EUR|GBP|ر\\.س|د\\.إ|دولار(?:ات)?|ريال|درهم|dollars?|euros?|pesos?|dólares?)";
const num="(?:"+D+"{1,3}(?:[,.٬\\u00a0\\u202f]"+D+"{3})+(?:[.,٫]"+D+"+)?|"+D+"{1,3}(?: "+D+"{3})+,[0-9٠-٩۰-۹]+|"+D+"+(?:[.,٫]"+D+"+)?)";
const amount="(?:\\(\\s*[-−+]?"+currency+"\\s*[-−+]?"+num+"\\s*\\)|[-−+]?\\s*(?:"+currency+"\\s*[-−+]?\\s*)?"+num+"(?:[ \\u00a0\\u202f]*"+currency+")?)";
const clock="(?:"+D+"{1,2}:"+D+"{2}(?::"+D+"{2})?(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?|ص|م|صباحًا|مساءً))?|"+D+"{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?|ص|م)|"+D+"{1,2}\\s*h(?:"+D+"{2})?)";
const months="(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|ene(?:ro)?|feb(?:rero)?|marzo|abr(?:il)?|mayo|junio|julio|ago(?:sto)?|septiembre|setiembre|octubre|noviembre|diciembre|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)";
const weekday="(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|lun(?:es)?|mar(?:tes)?|mié(?:rcoles)?|mie(?:rcoles)?|jue(?:ves)?|vie(?:rnes)?|sáb(?:ado)?|sab(?:ado)?|dom(?:ingo)?)";
const date="(?:"+D+"{4}-"+D+"{1,2}-"+D+"{1,2}|(?:"+weekday+"\\s+)?"+D+"{1,2}\\/"+D+"{1,2}(?:\\/"+D+"{2,4})?|"+months+"\\s+"+D+"{1,2}(?:,\\s*"+D+"{4})?|"+D+"{1,2}\\s+(?:de\\s+)?"+months+"(?:\\s+"+D+"{4})?)";
const durationUnit="(?:hours?|hrs?|minutes?|mins?|min|days?|weeks?|months?|días?|semanas?|horas?|hora|minutos?|meses?|ساعات?|ساعة|دقائق?|دقيقة|أيام|ايام|أسابيع|اسابيع|أشهر|شهور)";
const join="(?:\\s*(?:[–—-]|\\bto\\b|\\ba\\b|إلى)\\s*)";
const normal=(s:string)=>s.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0));
/** Mixed punctuation uses its rightmost decimal mark; otherwise use the locale. */
export function numericValue(raw:string,locale:NumberLocale):number {
 let s=normal(raw).replace(/٬/g,"").replace(/٫/g,".").replace(/[\s\u00a0\u202f]/g,"");
 const dot=s.lastIndexOf("."),comma=s.lastIndexOf(",");
 if(dot>=0&&comma>=0)s=dot>comma?s.replace(/,/g,""):s.replace(/\./g,"").replace(",",".");
 else if(comma>=0){const count=s.match(/,/g)?.length??0;s=count>1||(locale==="en"&&s.length-comma-1===3)?s.replace(/,/g,""):s.replace(",",".");}
 else if(dot>=0){const count=s.match(/\./g)?.length??0;if(count>1||(locale!=="en"&&s.length-dot-1===3))s=s.replace(/\./g,"");}
 return Number(s);
}
const expr=(s:string)=>new RegExp(s,"giu");
function amountValue(raw:string,locale:NumberLocale):number|null {
 const neg=/^\s*\(/u.test(raw)||/[-−]/u.test(raw);
 const digits=raw.replace(expr(currency),"").replace(/[%٪()+−-]/g,"").trim();
 const value=numericValue(digits,locale);
 return Number.isFinite(value)?value*(neg?-1:1):null;
}
function boundary(text:string,start:number,end:number){
 return !/[\p{L}\p{N}_]/u.test(text[start-1]??"")&&!/[\p{L}\p{N}_]/u.test(text[end]??"");
}
export function tokenizeNumbers(text:string,locale:NumberLocale):NumberToken[]{
 type Entry=NumberToken&{priority:number}; const all:Entry[]=[];
 const add=(start:number,end:number,kind:NumberTokenKind,value:number|null,unit:string|null,priority:number)=>{
  while(start<end&&/\s/u.test(text[start]))start++;
  while(end>start&&/\s/u.test(text[end-1]))end--;
  if(start>=0&&end>start&&boundary(text,start,end))all.push({start,end,kind,value,unit,priority});
 };
 const scan=(pattern:string,kind:NumberTokenKind,priority:number,value:(s:string)=>number|null=()=>null,unit:string|null=null)=>{
  for(const m of text.matchAll(expr(pattern)))add(m.index,m.index+m[0].length,kind,value(m[0]),unit,priority);
 };
 scan(date+"\\s*"+join+date,"dateRange",110);
 scan(date,"date",105);
 for(const m of text.matchAll(expr("("+clock+")"+join+"("+clock+")"))){
  if(!boundary(text,m.index,m.index+m[0].length))continue;
  const split=m[0].lastIndexOf(m[2]);
  add(m.index,m.index+m[1].length,"clockRange",null,null,101);
  add(m.index+split,m.index+split+m[2].length,"clockRange",null,null,101);
 }
 scan(clock,"clock",100);
 scan(num+"\\s*"+durationUnit+"(?!\\p{L})","duration",95,
   s=>amountValue(s.replace(expr(durationUnit),""),locale),"duration");
 for(const m of text.matchAll(expr("("+amount+")"+join+"("+amount+")"))){
  const split=m[0].lastIndexOf(m[2]),money=expr(currency).test(m[0]);
  const first=amountValue(m[1],locale),second=amountValue(m[2],locale);
  add(m.index,m.index+m[1].length,money?"money":"range",first===null?null:money?Math.round(first*100):first,money?"cents":null,85);
  add(m.index+split,m.index+split+m[2].length,money?"money":"range",second===null?null:money?Math.round(second*100):second,money?"cents":null,85);
 }
 scan("(?:\\+?\\d{1,3}[-. ]){2,}\\d{3,4}(?!\\d)","phone/id",82);
 scan("(?:gpt[-\\w.]*\\d[\\w.-]*|[A-Za-z]{1,8}[-_]\\d[\\w.-]*)","phone/id",82);
 scan(D+"+(?:st|nd|rd|th|º|ª|°|er|do|ro|to)","ordinal",80);
 for(const m of text.matchAll(expr("(?:\\(\\s*[-−+]?"+currency+"\\s*"+num+"\\s*\\)|[-−+]?\\s*(?:"+currency+"\\s*)?"+num+"(?:[ \\u00a0\\u202f]*(?:[%٪]|"+currency+"))?)"))){
  const start=m.index,end=start+m[0].length,raw=m[0];
  const money=expr(currency).test(raw),percent=/[%٪]\s*$/u.test(raw),n=amountValue(raw,locale);
  if(n===null)continue;
  const kind:NumberTokenKind=money?"money":percent?"percent":/[.,٬٫]/u.test(raw)?"decimal":"count";
  add(start,end,kind,money||percent?Math.round(n*100):n,money?"cents":percent?"bps":null,30);
 }
 all.sort((a,b)=>b.priority-a.priority||(b.end-b.start)-(a.end-a.start)||a.start-b.start);
 const kept:Entry[]=[];
 for(const item of all)if(!kept.some(t=>item.start<t.end&&item.end>t.start))kept.push(item);
 return kept.sort((a,b)=>a.start-b.start).map(({priority:_priority,...rest})=>rest);
}
