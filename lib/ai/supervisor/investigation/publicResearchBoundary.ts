/** Only public-purpose, owner-authored research requests may leave our server.
 * This is an outbound privacy firewall, not a conversational intent router.
 * No second model or private staff/finance source is sent for review.
 */
const confidential=/\b(?:payroll|employee|staff|wages?|salary|salaries|revenue|profit|income|bank|account|customer|customers|phone|email|rent|invoice|transactions?|credit|ssn|social security|expense|expenses|labor|labour|cashflow|tax|taxes|n[oó]mina|sueldos?|salarios?|empleados?|personal|ingresos?|ganancias?|beneficios?|banco|cuenta|clientes?|tel[eé]fono|correo|facturas?|gastos?|alquiler|impuestos?|pago|ventas|رواتب|راتب|موظف|موظفين|عمال|عملاء|زبائن|حساب|بنك|أرباح|ربح|مبيعات|فواتير|فاتورة|أجور|ضرائب|تكاليف|دخل|البريد|هاتف|سري|خاص)\b/iu;
const arabicPrivate=/(?:رواتب|راتب|موظف|موظفين|عمال|عملاء|زبائن|حساب|بنك|أرباح|ربح|مبيعات|فواتير|فاتورة|أجور|ضرائب|تكاليف|دخل|البريد|هاتف|سري|خاص)/u;
export function publicResearchOnly(ownerText:string,clause:string,query:string,publicContext:string):boolean{
 if(!clause.trim()||!query.trim()||publicContext.trim()||!ownerText.includes(clause))return false;
 // Querying an owner's private numbers (even if "owner-authored") publishes
 // confidential facts to an external search provider. Decline mixed cases.
 if(/[\p{Nd}$€£¥@]|https?:\/\//iu.test(ownerText+" "+clause+" "+query))return false;
 if(confidential.test(ownerText)||confidential.test(clause)||confidential.test(query)||
    arabicPrivate.test(ownerText)||arabicPrivate.test(clause)||arabicPrivate.test(query))return false;
 // A model must not add proper nouns or identifiers from private memories.
 const words=(s:string)=>s.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}]+/gu)??[];
 const allowed=new Set(words(clause+" cafe café coffee menu supplier suppliers competitor competitors prices nearby público public mercado mercado mercado proveedores أسعار قوائم مقهى موردين منافسين"));
 return words(query).every(w=>allowed.has(w));
}
