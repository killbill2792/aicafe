import { createHash } from "node:crypto";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { EvidenceReference, SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";

type Locale = "en" | "es" | "ar";
type ReadView = { blocks: SupervisorReplyBlock[]; evidence: EvidenceReference[] };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Never render raw UUIDs, internal instructions, URLs, provider data or model prose. */
const privateField = /(?:^id$|id$|uuid|token|secret|password|key$|payload|url|uri|href|instruction|email|phone|address|audit|revision)/iu;
const humanize = (key: string) => key.replace(/([a-z\d])([A-Z])/gu,"$1 $2")
  .replace(/[._-]+/gu," ").trim().slice(0,65);
const safeText = (text: string) => {
  const cleaned=text.replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
  return cleaned && cleaned.length<=120 && !/https?:\/\/|www\./iu.test(cleaned)
    ? cleaned : null;
};
const label = {
  en:{partial:"Partial source read",quality:"Coverage and source revision are not independently verified. Do not treat a missing record as zero, a quote as inventory, or a plan as completed.",empty:"No displayable evidence in the authorized sample.",more:"Showing a bounded sample only; not a complete count.",failure:"This part of the request still needs additional evidence or a supported calculation."},
  es:{partial:"Lectura parcial de la fuente",quality:"La cobertura y la revisión de la fuente no están verificadas. La ausencia de registros no significa cero; una cotización no es inventario ni un plan es un resultado ejecutado.",empty:"No hay evidencia visible en la muestra autorizada.",more:"Solo se muestra una muestra limitada, no un recuento completo.",failure:"Esta parte de la solicitud aún necesita evidencia o un cálculo autorizado."},
  ar:{partial:"قراءة جزئية للمصدر",quality:"لم يتم التحقق من اكتمال السجلات أو إصدار المصدر. غياب السجلات ليس صفرًا، وعرض السعر ليس مخزونًا، والخطة ليست تنفيذًا.",empty:"لا توجد أدلة قابلة للعرض في العينة المصرح بها.",more:"تُعرض عينة محدودة وليست عددًا نهائيًا.",failure:"يتطلب هذا الجزء أدلة إضافية أو حسابًا مدعومًا."},
} as const;

/** Generic schema-validated record preview. No domain keyword routing or math. */
function scalar(key:string,value:unknown,locale:Locale,missing:boolean):string|null {
  if(privateField.test(key)) return null;
  if(typeof value==="string")return safeText(value);
  if(typeof value==="number" && Number.isSafeInteger(value) &&
    Math.abs(value)<=1_000_000_000_000){
    // An absent numeric input cannot be silently shown as a verified zero.
    if(value===0 && missing)return null;
    if(/cents$/iu.test(key))return new Intl.NumberFormat(locale,
      {style:"currency",currency:"USD"}).format(value/100);
    return new Intl.NumberFormat(locale).format(value);
  }
  return null;
}
function visibleFields(value:unknown,locale:Locale,missing:boolean):string[] {
  if(typeof value==="number")return [scalar("value",value,locale,missing)??""].filter(Boolean);
  if(!isRecord(value))return [];
  const parts:string[]=[];
  for(const [key,raw] of Object.entries(value)){
    if(parts.length>=6)break;
    const formatted=scalar(key,raw,locale,missing);
    if(formatted!==null)parts.push(humanize(key)+": "+formatted);
  }
  return parts;
}
function previews(value:unknown,locale:Locale,missing:boolean):string[] {
  if(Array.isArray(value))return value.slice(0,2)
    .map(v=>visibleFields(v,locale,missing).join(" · ")).filter(Boolean);
  if(isRecord(value)){
    const nested=Object.entries(value).find(([key,raw])=>
      !privateField.test(key)&&Array.isArray(raw));
    if(nested){
      const [key,rows]=nested as [string,unknown[]];
      const records=previews(rows,locale,missing).map(row=>humanize(key)+": "+row);
      return records.length?records:visibleFields(value,locale,missing);
    }
  }
  const fields=visibleFields(value,locale,missing);
  return fields.length?[fields.join(" · ")]:[];
}

/** Called only after registry.invoke has checked the strict source output.
 * These independent P1 reads are ALWAYS displayed as provisional, never
 * synthesized as a coherent P3 atomic financial/scheduling snapshot.
 */
export function presentRegisteredReads(params:{
  evidence:readonly ShadowEvidence[];includedClauses:readonly string[];
  businessId:string;asOf:string;locale:Locale;
}):ReadView {
  const {evidence,includedClauses,businessId,asOf,locale}=params;
  const blocks:SupervisorReplyBlock[]=[];
  const refs:EvidenceReference[]=[];
  const selected=new Set(includedClauses);
  for(const item of evidence){
    if(!selected.has(item.clause)||!item.capabilityId ||
      !["verified","partial","estimated"].includes(item.status) ||
      !isRecord(item.result))continue;
    const result=item.result;
    if(!isRecord(result.provenance) ||
      result.provenance.asOf!==asOf ||
      typeof result.provenance.canonicalReaderId!=="string" ||
      typeof result.provenance.purpose!=="string" ||
      typeof result.id!=="string" ||
      item.capabilityId!=="p3."+result.id+".v1" ||
      !isRecord(result.quality) ||
      !Array.isArray(result.quality.missingInputs) ||
      !Array.isArray(result.quality.estimatedInputs) ||
      !Array.isArray(result.quality.staleInputs) ||
      !Object.hasOwn(result,"value"))continue;
    const ref:EvidenceReference={source:"cafe_state",
      identifier:"p3:read:"+createHash("sha256").update(JSON.stringify({
        businessId,asOf,capabilityId:item.capabilityId,query:result.query,
        canonicalReaderId:result.provenance.canonicalReaderId,
        value:result.value,quality:result.quality,
      })).digest("hex").slice(0,32),asOf};
    const missing=result.quality.missingInputs.length>0 ||
      result.quality.staleInputs.length>0;
    const rendered=previews(result.value,locale,missing).slice(0,2);
    const heading=humanize(result.id)+": "+label[locale].partial;
    blocks.push({type:"text",text:heading});
    for(const text of rendered)blocks.push({type:"text",text:text.slice(0,1150)});
    if(!rendered.length)blocks.push({type:"text",text:label[locale].empty});
    blocks.push({type:"warning",code:"P3_READ_PARTIAL",text:label[locale].quality});
    if(Array.isArray(result.value) && result.value.length>2 ||
      isRecord(result.value)&&Object.values(result.value).some(v=>Array.isArray(v)&&v.length>2))
      blocks.push({type:"text",text:label[locale].more});
    refs.push(ref);
    if(blocks.length>=22)break;
  }
  return {blocks:blocks.slice(0,24),evidence:refs.slice(0,8)};
}
