import { createHash } from "node:crypto";
import type { ShadowEvidence } from "@/lib/ai/supervisor/p2/shadow.server";
import type { EvidenceReference, SupervisorReplyBlock } from
  "@/lib/ai/conversations/contracts";

type Locale = "en" | "es" | "ar";
type ReadView = { blocks: SupervisorReplyBlock[]; evidence: EvidenceReference[] };
type Translation = Record<Locale,string>;
type PresentedField = "supplierName" | "itemName" | "priceCents" |
  "packageCount" | "name" | "label" | "amountCents" | "totalCents" |
  "defaultHourlyWageCents" | "wageAmountCents" | "ingredientsCentsToday";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sourcePresentation:Record<string,{heading:Translation;fields:readonly PresentedField[]}> = {
  "supplies.quotes":{
    heading:{en:"Supplier quotes",es:"Cotizaciones de proveedores",ar:"عروض أسعار الموردين"},
    fields:["supplierName","itemName","priceCents","packageCount"],
  },
  "menu.catalog":{
    heading:{en:"Menu catalog",es:"Catálogo del menú",ar:"قائمة المنتجات"},
    fields:["name","priceCents"],
  },
  "menu.product_economics":{
    heading:{en:"Product costs",es:"Costos del producto",ar:"تكاليف المنتج"},
    fields:["name","priceCents","ingredientsCentsToday"],
  },
  "menu.ingredients":{
    heading:{en:"Ingredients",es:"Ingredientes",ar:"المكونات"},
    fields:["name"],
  },
  "labor.employee_wages":{
    heading:{en:"Recorded staff wages",es:"Salarios registrados",ar:"الأجور المسجلة"},
    fields:["name","defaultHourlyWageCents","wageAmountCents"],
  },
  "money.monthly_bills":{
    heading:{en:"Recurring obligations",es:"Obligaciones recurrentes",ar:"الالتزامات المتكررة"},
    fields:["totalCents"],
  },
  "money.recurring_bill_rows":{
    heading:{en:"Recurring bills",es:"Facturas recurrentes",ar:"الفواتير المتكررة"},
    fields:["label","amountCents"],
  },
  "money.recorded_spending":{
    heading:{en:"Recorded spending",es:"Gastos registrados",ar:"النفقات المسجلة"},
    fields:["totalCents"],
  },
  "money.expense_entries":{
    heading:{en:"Expense entries",es:"Gastos registrados",ar:"قيود النفقات"},
    fields:["amountCents"],
  },
};
const fieldLabels:Record<PresentedField,Translation> = {
  supplierName:{en:"Supplier",es:"Proveedor",ar:"المورد"},
  itemName:{en:"Item",es:"Producto",ar:"الصنف"},
  priceCents:{en:"Recorded price",es:"Precio registrado",ar:"السعر المسجل"},
  packageCount:{en:"Package quantity",es:"Cantidad de paquetes",ar:"عدد العبوات"},
  name:{en:"Name",es:"Nombre",ar:"الاسم"},
  label:{en:"Bill",es:"Factura",ar:"الفاتورة"},
  amountCents:{en:"Recorded amount",es:"Importe registrado",ar:"المبلغ المسجل"},
  totalCents:{en:"Recorded total",es:"Total registrado",ar:"الإجمالي المسجل"},
  defaultHourlyWageCents:{en:"Hourly wage",es:"Salario por hora",ar:"أجر الساعة"},
  wageAmountCents:{en:"Recorded wage",es:"Salario registrado",ar:"الأجر المسجل"},
  ingredientsCentsToday:{en:"Current recipe ingredients",es:"Ingredientes de receta actuales",ar:"مكونات الوصفة الحالية"},
};
const labels = {
  en:{partial:"Provisional source read",quality:"Coverage and source revision are not independently verified. This is not a complete business total, verified stock count or completed action.",empty:"No supported fields are available in this authorized sample.",more:"Only a small sample is shown, not a complete count."},
  es:{partial:"Lectura provisional",quality:"La cobertura y la revisión del origen no están verificadas. No representa un total completo, existencias confirmadas ni una acción ejecutada.",empty:"No hay campos admitidos en esta muestra autorizada.",more:"Solo se muestra una muestra pequeña, no un recuento completo."},
  ar:{partial:"قراءة أولية من المصدر",quality:"لم يتم التحقق من اكتمال السجلات أو إصدار المصدر. ليست هذه حصيلة شاملة أو مخزونًا مؤكدًا أو إجراءً منفذًا.",empty:"لا توجد حقول مدعومة في هذه العينة المصرح بها.",more:"تُعرض عينة صغيرة وليست عددًا نهائيًا."},
} as const;
const safeText=(value:string):string|null=>{
  const text=value.replace(/[\p{Cc}\p{Cf}]/gu," ").replace(/\s+/gu," ").trim();
  return text && text.length<=120 && !/https?:\/\/|www\./iu.test(text)?text:null;
};
function displayedField(id:string,row:Record<string,unknown>,key:PresentedField,
  locale:Locale):string|null{
  const value=row[key];
  // A missing canonical cost/price is not an observed zero. The P1 record
  // carries field-specific status; the overall missingInputs array does not
  // authorize hiding a different, explicitly recorded zero value.
  if(key==="priceCents" && id==="menu.catalog" && row.priceStatus!=="recorded")return null;
  if(key==="ingredientsCentsToday" && row.costStatus!=="READY")return null;
  if((key==="wageAmountCents"||key==="defaultHourlyWageCents") &&
    row.wageKnown!==true)return null;
  if(typeof value==="string"){
    if(!["supplierName","itemName","name","label"].includes(key))return null;
    const text=safeText(value);
    return text?fieldLabels[key][locale]+": "+text:null;
  }
  if(typeof value==="number"&&Number.isSafeInteger(value)&&
    Math.abs(value)<=1_000_000_000_000){
    // Every emitted scalar has a reviewed source-specific meaning. Retain
    // recorded zero even if some DIFFERENT source field is unavailable.
    const formatted=key.endsWith("Cents")
      ?new Intl.NumberFormat(locale,{style:"currency",currency:"USD"}).format(value/100)
      :new Intl.NumberFormat(locale).format(value);
    return fieldLabels[key][locale]+": "+formatted;
  }
  return null;
}
function previews(id:string,value:unknown,locale:Locale,fields:readonly PresentedField[]):string[]{
  const rows=Array.isArray(value)?value:
    isRecord(value)&&Array.isArray(value.items)?value.items:[value];
  const bounded=rows.slice(0,2).filter(isRecord);
  return bounded.map(row=>fields.map(field=>displayedField(id,row,field,locale))
    .filter((x):x is string=>x!==null).join(" · ")).filter(Boolean);
}
/** Domain source labels and fields are checked-in, reviewed presentation
 * contracts, not model-authored schema names or mutable source enum strings.
 * No raw IDs, URLs, instructions, or unknown source fields enter owner text.
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
    const presentation=sourcePresentation[result.id];
    // Unknown future domain schemas must ship their own reviewed presentation
    // contract; never reflect arbitrary source keys or enums to the owner.
    if(!presentation)continue;
    const ref:EvidenceReference={source:"cafe_state",
      identifier:"p3:read:"+createHash("sha256").update(JSON.stringify({
        businessId,asOf,capabilityId:item.capabilityId,query:result.query,
        canonicalReaderId:result.provenance.canonicalReaderId,
        value:result.value,quality:result.quality,
      })).digest("hex").slice(0,32),asOf};
    const rendered=previews(result.id,result.value,locale,presentation.fields);
    blocks.push({type:"text",text:presentation.heading[locale]+": "+labels[locale].partial});
    for(const text of rendered)blocks.push({type:"text",text:text.slice(0,1150)});
    if(!rendered.length)blocks.push({type:"text",text:labels[locale].empty});
    blocks.push({type:"warning",code:"P3_READ_PARTIAL",text:labels[locale].quality});
    if(Array.isArray(result.value) && result.value.length>2 ||
      isRecord(result.value)&&Array.isArray(result.value.items)&&result.value.items.length>2)
      blocks.push({type:"text",text:labels[locale].more});
    refs.push(ref);
    if(blocks.length>=22)break;
  }
  return {blocks:blocks.slice(0,24),evidence:refs.slice(0,8)};
}
