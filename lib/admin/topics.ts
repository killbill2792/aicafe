/** Stable rule-based topics, not another model call or an invented AI classification.
 * Version 1 is stored by the daily cron; 'other' remains visible, not discarded. */
export const TOPIC_VERSION = 1;
export const topicLabels: Record<string,string> = {
  break_even:"Break-even",best_sellers:"Best sellers",labor:"Labor cost",
  schedule:"Scheduling",menu_price:"Menu pricing",sales:"Sales",expenses:"Expenses",
  inventory:"Inventory and supplies",other:"Other",pending_classification:"Not classified yet",
};
export const homeCardCandidates = new Set([
  "break_even","best_sellers","labor","schedule","menu_price","sales","expenses","inventory",
]);
const rules: {topic:string;terms:RegExp}[] = [
  {topic:"break_even",terms:/(break[\s-]?even|cover (my |our )?cost|profit threshold|punto de equilibrio|cubrir (los )?gastos|نقطة التعادل|التعادل|تغطية التكاليف)/u},
  {topic:"best_sellers",terms:/(best[\s-]?sell|top sell|most popular|most sold|top product|mas vendido|mas popular|mas pedidos|الأكثر مبيعا|افضل مبيع|المنتجات الاكثر)/u},
  {topic:"schedule",terms:/(schedul|shift|roster|availability|clock.?in|turnos|horario|disponibilidad|جدول|المناوب|وردية|الدوام)/u},
  {topic:"labor",terms:/(labor|labour|payroll|wage|staff.?hour|overtime|nomina|salarios|mano de obra|تكلفة العمالة|الرواتب|العمل الاضافي)/u},
  {topic:"menu_price",terms:/(menu pric|item pric|price change|raise (the )?price|pricing|menu margin|precio|precios|subir (el )?precio|سعر|تسعير|الاسعار)/u},
  {topic:"inventory",terms:/(stock|inventory|ingredient|suppl|restock|milk usage|inventario|ingrediente|insumo|مخزون|مكونات|المشتريات)/u},
  {topic:"expenses",terms:/(expenses?|rent|bill|cost breakdown|overhead|utilities|gastos|alquiler|factura|تكاليف|المصاريف|الفواتير|الايجار)/u},
  {topic:"sales",terms:/(sales|revenue|transactions?|orders?|ventas|ingresos|pedidos|المبيعات|الايرادات|الطلبات)/u},
];
export function classifyOwnerQuestion(question:string):string {
  const normalized=question.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  return rules.find(rule=>rule.terms.test(normalized))?.topic??"other";
}
