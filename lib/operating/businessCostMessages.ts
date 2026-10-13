import type {BusinessCostSummary} from "./types";

/** Translate only canonical categories/counts, never business or database identifiers. */
export function businessCostLimitations(summary:BusinessCostSummary,locale:"en"|"es"|"ar"):string {
  const c=summary.coverage;
  const names={
    en:{intro:"This is not yet a complete total.",products:"Product/ingredient costs are incomplete for",
      productsEnd:"products.",fees:"Processing fees are missing for",days:"recorded sales days.",
      sales:"Sales coverage is incomplete.",staff:"Staff cost coverage is incomplete.",
      items:"Product-level sales and ingredient-cost coverage are not verified for this period.",
      historical:"Ingredient costs recorded on the original sales dates have not been verified.",
      priorMonth:"Previous-month running costs use the current month's amounts as an estimate.",
      expense:"has not been entered.",unknown:"Business cost records have not been verified."},
    es:{intro:"Este importe aún no es un total completo.",products:"Faltan costos completos de productos o ingredientes para",
      productsEnd:"productos.",fees:"Faltan comisiones de procesamiento en",days:"días de ventas registrados.",
      sales:"La cobertura de ventas está incompleta.",staff:"La cobertura del costo de personal está incompleta.",
      items:"No se ha verificado la cobertura de ventas por producto y costos de ingredientes de este período.",
      historical:"No se han verificado los costos de ingredientes registrados en las fechas originales de venta.",
      priorMonth:"Los costos operativos del mes anterior se estiman usando los importes del mes actual.",
      expense:"no se ha registrado.",unknown:"No se han verificado los registros de costos del negocio."},
    ar:{intro:"هذا ليس إجماليًا مكتملًا بعد.",products:"تكاليف المنتجات أو المكونات غير مكتملة لعدد",
      productsEnd:"منتج.",fees:"رسوم معالجة الدفع مفقودة لعدد",days:"أيام مبيعات مسجلة.",
      sales:"تغطية المبيعات غير مكتملة.",staff:"تغطية تكاليف الموظفين غير مكتملة.",
      items:"لم يتم التحقق من تغطية مبيعات المنتجات وتكاليف المكونات لهذه الفترة.",
      historical:"لم يتم التحقق من تكاليف المكونات المسجلة في تواريخ البيع الأصلية.",
      priorMonth:"تُقدَّر تكاليف التشغيل للشهر السابق باستخدام مبالغ الشهر الحالي.",
      expense:"لم يتم إدخاله.",unknown:"لم يتم التحقق من سجلات تكاليف العمل."},
  }[locale];
  if(summary.completeness==="unavailable")return names.unknown;
  if(summary.completeness==="complete")return "";
  const categories:{
    [code:string]:[string,string,string];
  }={
    rent:["Rent","El alquiler","الإيجار"],
    utilities_power:["Electricity","La electricidad","الكهرباء"],
    water:["Water","El agua","المياه"],
    internet:["Internet","El internet","الإنترنت"],
    insurance:["Insurance","El seguro","التأمين"],
    loan:["Loan cost","El préstamo","القرض"],
    software:["Software","El software","البرامج"],
    supplies:["Supplies","Los suministros","المستلزمات"],
    repairs:["Repairs","Las reparaciones","الإصلاحات"],
    ingredients:["Ingredients","Los ingredientes","المكونات"],
    other:["Other operating cost","Otros costos operativos","تكاليف تشغيل أخرى"],
  };
  const language=locale==="en"?0:locale==="es"?1:2;
  const issues:string[]=[];
  if(!c.itemSalesCovered)issues.push(names.items);
  else if(!c.historicalIngredientCostsProven)issues.push(names.historical);
  if(summary.missingInputs.includes("priorMonthRunningCostCoverage"))
    issues.push(names.priorMonth);
  if(c.missingProductCostCount>0)issues.push(
    names.products+" "+c.missingProductCostCount+" "+names.productsEnd);
  if(c.missingFeeDays>0)issues.push(
    names.fees+" "+c.missingFeeDays+" "+names.days);
  for(const item of c.missingOperatingCategories.slice(0,3)){
    const label=categories[item.code]?.[language];
    if(label)issues.push(label+" "+names.expense);
  }
  if(c.salesDays<c.expectedDays)issues.push(names.sales);
  if(c.laborDays<c.expectedDays)issues.push(names.staff);
  return (names.intro+" "+issues.slice(0,5).join(" ")).trim();
}
