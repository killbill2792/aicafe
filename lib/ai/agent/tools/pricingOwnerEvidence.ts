/** Verify only amounts an owner actually associated with the named cost. */
const digits=(value:string)=>value.replace(/[٠-٩]/gu,c=>String(c.charCodeAt(0)-0x660))
 .replace(/[۰-۹]/gu,c=>String(c.charCodeAt(0)-0x6f0));
function decimal(value:string):number{
 const raw=digits(value).replace(/٫/gu,".").replace(/٬/gu,",");
 const dot=raw.lastIndexOf("."),comma=raw.lastIndexOf(",");
 const last=Math.max(dot,comma);
 if(last<0)return Number(raw);
 const fraction=raw.length-last-1;
 if(fraction<1||fraction>2)return Number(raw.replace(/[.,]/gu,""));
 return Number(raw.slice(0,last).replace(/[.,]/gu,"")+"."+raw.slice(last+1));
}
const billWords=/(?:\b(?:bills?|rent|overheads?|utilities|facturas?|alquiler|servicios(?:\s+públicos)?|gastos\s+(?:generales|fijos))\b|(?:فواتير|فاتورة|إيجار|الايجار|الإيجار|مرافق|الكهرباء|المصاريف العامة|التكاليف التشغيلية))/giu;
const laborWords=/(?:\b(?:labor|labour|wages?|payroll|salar(?:y|ies)|staff|nómina|nomina|salarios?|sueldos?|mano de obra)\b|(?:رواتب|أجور|العمالة|الرواتب|الأجور|الراتب))/giu;
export function ownerSpecifiedMonthlyBills(utterances:readonly string[],cents:number):boolean{
 if(!Number.isSafeInteger(cents)||cents<0)return false;
 return utterances.some(line=>{
  for(const match of line.matchAll(/[\p{N}][\p{N},٬.٫]*/gu)){
   if(!Number.isFinite(decimal(match[0]))||Math.round(decimal(match[0])*100)!==cents)continue;
   const start=match.index,finish=start+match[0].length;
   if(/^\s*[%٪]/u.test(line.slice(finish)))continue;
   const before=line.slice(Math.max(0,start-75),start);
   const after=line.slice(finish,Math.min(line.length,finish+25));
   const nearby=before+match[0]+after;
   const midpoint=before.length;
   const labels=[
    ...[...nearby.matchAll(billWords)].map(m=>({kind:"bills",distance:
      m.index>=midpoint?m.index-(midpoint+match[0].length):midpoint-(m.index+m[0].length)})),
    ...[...nearby.matchAll(laborWords)].map(m=>({kind:"labor",distance:
      m.index>=midpoint?m.index-(midpoint+match[0].length):midpoint-(m.index+m[0].length)}))
   ].filter(item=>item.distance>=0).sort((a,b)=>a.distance-b.distance);
   if(labels[0]?.kind==="bills")return true;
  }
  return false;
 });
}
export function ownerSpecifiedPercent(utterances:readonly string[],value:number|null|undefined,
 kind:"drinkCost"|"operatingMargin"):boolean{
 if(value==null||!Number.isFinite(value))return false;
 const prefix=kind==="drinkCost"?
  /(?:\b(?:drink|product|ingredient)\s*cost\b|\b(?:costo|coste)(?:\s+(?:de|del|de la))?\s*(?:bebida|producto|ingredientes?)\b|(?:تكلفة|تكاليف)\s*(?:المشروب|المنتج|المكونات)?)/u.source:
  /(?:\b(?:operating|profit)\s*margin\b|\bmargen(?:\s+(?:operativo|de beneficio|de ganancia))?|هامش(?:\s+(?:الربح|التشغيل))?)/u.source;
 const tail=/[^\p{N}%٪\n]{0,32}([\p{N}]+(?:[.,٫][\p{N}]+)?)\s*[%٪]/u.source;
 const pattern=new RegExp(prefix+tail,"giu");
 return utterances.some(line=>[...line.matchAll(pattern)].some(m=>Math.abs(decimal(m[1])-value)<.001));
}
