import { z } from "zod";
import type { SupervisorToolCall } from "./toolRegistry.server";

export const GOAL_DOMAINS = [
  "total_business_costs","staff_cost","menu_count","pricing_review","owner_profit",
  "monthly_bills","recorded_spending","sales","distinct_products","staffing",
  "team","break_even","overview","owner_rules","comparison",
  "staff_attendance","staff_schedule","staff_coverage",
] as const;
const periods = ["today","yesterday","week_to_date","previous_week","month_to_date",
  "previous_month","last_7_days","last_28_days","custom"] as const;
const goalSchema = z.strictObject({
  domain:z.enum(GOAL_DOMAINS),period:z.enum(periods),
  from:z.string().nullable(),to:z.string().nullable(),
  comparison_period:z.enum(periods).nullable(),comparison_from:z.string().nullable(),
  comparison_to:z.string().nullable(),
});
export const requestScopeSchema=z.strictObject({goals:z.array(goalSchema).min(1).max(5)});
export type RequestedGoal=z.infer<typeof goalSchema>;
export const scopeAuditSchema=z.strictObject({
  complete:z.boolean(),ambiguous:z.boolean(),goals:requestScopeSchema.shape.goals,
});
/** Named periods are defined by their period enum and café-local as-of date,
 * never by redundant from/to hints. Custom periods retain their exact dates. */
function canonicalPeriod(period:RequestedGoal["period"],from:string|null,to:string|null){
  return period==="custom" ? [period,from,to] : [period];
}
function canonicalGoal(g:RequestedGoal):RequestedGoal {
  return {
    ...g,
    from:g.period==="custom"?g.from:null,
    to:g.period==="custom"?g.to:null,
    comparison_from:g.domain==="comparison"&&g.comparison_period==="custom"?g.comparison_from:null,
    comparison_to:g.domain==="comparison"&&g.comparison_period==="custom"?g.comparison_to:null,
  };
}
function semanticGoalKey(g:RequestedGoal):string {
  return JSON.stringify([
    g.domain,...canonicalPeriod(g.period,g.from,g.to),
    ...(g.domain==="comparison"
      ? g.comparison_period===null ? [null]
        : canonicalPeriod(g.comparison_period,g.comparison_from,g.comparison_to)
      : []),
  ]);
}
function periodsMatch(period:RequestedGoal["period"],from:string|null,to:string|null,
  actualPeriod:unknown,actualFrom:unknown,actualTo:unknown):boolean {
  if(actualPeriod!==period)return false;
  if(period!=="custom")return true;
  return typeof from==="string"&&typeof to==="string"&&
    actualFrom===from&&actualTo===to;
}
export function normalizeRequestedGoals(goals:RequestedGoal[]):RequestedGoal[]{
  const keys=new Set<string>();
  return goals.map(canonicalGoal).filter(g=>{
    const key=semanticGoalKey(g);
    if(keys.has(key))return false;
    keys.add(key);return true;
  });
}
export function reconcileRequestScopes(declared:RequestedGoal[],audit:RequestedGoal[],
  complete:boolean,ambiguous:boolean):RequestedGoal[]|null {
  if(!complete||ambiguous)return null;
  const initial=normalizeRequestedGoals(declared),verified=normalizeRequestedGoals(audit);
  const audited=new Set(verified.map(semanticGoalKey));
  // A scope audit may ADD a missed goal exactly once; it cannot erase/change any
  // declared goal or silently accept a conflicting period.
  return initial.every(g=>audited.has(semanticGoalKey(g)))?verified:null;
}
type ReadCall=Pick<SupervisorToolCall,"name"|"arguments">;

/** This is a semantic plan supplied by the model, not an owner-phrase classifier.
 * The server then checks read tools/periods and requires a result for every goal. */
export function coversRequestedGoal(goal:RequestedGoal,call:ReadCall):boolean {
  const a=call.arguments;
  const datesMatch=()=>periodsMatch(goal.period,goal.from,goal.to,a.period,a.from,a.to);
  const comparisonMatches=()=>periodsMatch(goal.period,goal.from,goal.to,
    a.current_period,a.current_from,a.current_to) &&
    goal.comparison_period!==null &&
    periodsMatch(goal.comparison_period,goal.comparison_from,goal.comparison_to,
      a.comparison_period,a.comparison_from,a.comparison_to);
  switch(goal.domain){
    case "total_business_costs":return call.name==="get_financials" && a.metric==="total_business_costs" && datesMatch();
    case "staff_cost":return call.name==="get_staff" && a.view==="labor_cost" && datesMatch();
    case "menu_count":return call.name==="get_menu" && (a.view==="count"||a.view==="active_count");
    case "pricing_review":return call.name==="get_pricing";
    case "owner_profit":return call.name==="get_financials" && a.metric==="owner_profit" && datesMatch();
    case "monthly_bills":return call.name==="get_financials" && a.metric==="monthly_bills" && datesMatch();
    case "recorded_spending":return call.name==="get_financials" && a.metric==="recorded_spending" && datesMatch();
    case "sales":return call.name==="get_sales" && datesMatch();
    case "distinct_products":return call.name==="get_sales" && a.metric==="distinct_products" && datesMatch();
    case "staffing":return call.name==="get_staff" && a.view==="current_staffing" && datesMatch();
    case "staff_attendance":return call.name==="get_staff" && a.view==="attendance" && datesMatch();
    case "staff_schedule":return call.name==="get_staff" && a.view==="schedule" && datesMatch();
    case "staff_coverage":return call.name==="get_staff" && a.view==="coverage_issues" && datesMatch();
    case "team":return call.name==="get_team";
    case "break_even":return call.name==="get_financials" && a.metric==="break_even";
    case "overview":return call.name==="get_cafe_overview";
    case "owner_rules":return call.name==="get_owner_rules";
    case "comparison":return call.name==="compare_periods" && comparisonMatches();
  }
}
export function fallbackCallForGoal(goal:RequestedGoal): ReadCall | null {
  const date={period:goal.period,from:goal.from,to:goal.to};
  switch(goal.domain){
    case "total_business_costs":return {name:"get_financials",arguments:{metric:"total_business_costs",...date}};
    case "staff_cost":return {name:"get_staff",arguments:{view:"labor_cost",...date}};
    case "menu_count":return {name:"get_menu",arguments:{view:"active_count",scope:"active",product_name:null,limit:10}};
    case "pricing_review":return {name:"get_pricing",arguments:{product_name:null,limit:10}};
    case "owner_profit":return {name:"get_financials",arguments:{metric:"owner_profit",...date}};
    case "monthly_bills":return {name:"get_financials",arguments:{metric:"monthly_bills",...date}};
    case "recorded_spending":return {name:"get_financials",arguments:{metric:"recorded_spending",...date}};
    case "sales":return {name:"get_sales",arguments:{metric:"net_sales",group_by:"total",...date,category:"all",
      product_name:null,sort:"highest",limit:10}};
    case "distinct_products":return {name:"get_sales",arguments:{metric:"distinct_products",group_by:"total",...date,
      category:"all",product_name:null,sort:"highest",limit:10}};
    case "staffing":return goal.period==="today"
      ? {name:"get_staff",arguments:{view:"current_staffing",...date}} : null;
    case "staff_attendance":return {name:"get_staff",arguments:{view:"attendance",...date}};
    case "staff_schedule":return {name:"get_staff",arguments:{view:"schedule",...date}};
    case "staff_coverage":return {name:"get_staff",arguments:{view:"coverage_issues",...date}};
    case "team":return {name:"get_team",arguments:{status:"all",agent:"all",view:"tasks",limit:10}};
    case "break_even":return {name:"get_financials",arguments:{metric:"break_even",...date}};
    case "overview":return {name:"get_cafe_overview",arguments:{focus:"month_to_date"}};
    case "owner_rules":return {name:"get_owner_rules",arguments:{agent:"all"}};
    case "comparison":return null; // period pairing needs a semantic comparison, never guess it
  }
}
const copy={
  en:{
    total_business_costs:"Total business costs",staff_cost:"Staff cost",menu_count:"Products on your menu",
    pricing_review:"Verified price changes",owner_profit:"Owner profit",monthly_bills:"Recurring monthly bills",
    recorded_spending:"Recorded spending",sales:"Sales",distinct_products:"Products customers bought",
    staffing:"Staffing",staff_attendance:"Staff attendance",staff_schedule:"Staff schedule",
    staff_coverage:"Staff coverage",team:"AI Team",break_even:"Break-even",overview:"Café overview",
    owner_rules:"Owner rules",comparison:"Period comparison",
    unavailable:"Unable to verify from the available records.",
  },
  es:{
    total_business_costs:"Costos totales del negocio",staff_cost:"Costo del personal",menu_count:"Productos del menú",
    pricing_review:"Cambios de precio verificados",owner_profit:"Ganancia del propietario",
    monthly_bills:"Facturas mensuales recurrentes",recorded_spending:"Gastos registrados",
    sales:"Ventas",distinct_products:"Productos comprados por clientes",staffing:"Personal",
    staff_attendance:"Asistencia del personal",staff_schedule:"Horario del personal",staff_coverage:"Cobertura del personal",
    team:"Equipo de IA",break_even:"Punto de equilibrio",overview:"Resumen del café",
    owner_rules:"Reglas del propietario",comparison:"Comparación de períodos",
    unavailable:"No se puede verificar con los registros disponibles.",
  },
  ar:{
    total_business_costs:"إجمالي تكاليف العمل",staff_cost:"تكلفة الموظفين",menu_count:"منتجات القائمة",
    pricing_review:"تغييرات الأسعار المثبتة",owner_profit:"ربح المالك",monthly_bills:"الفواتير الشهرية المتكررة",
    recorded_spending:"المصروفات المسجلة",sales:"المبيعات",distinct_products:"المنتجات التي اشتراها العملاء",
    staffing:"الموظفون",staff_attendance:"حضور الموظفين",staff_schedule:"جدول الموظفين",
    staff_coverage:"تغطية الموظفين",team:"فريق الذكاء الاصطناعي",break_even:"نقطة التعادل",
    overview:"نظرة عامة على المقهى",owner_rules:"قواعد المالك",comparison:"مقارنة الفترات",
    unavailable:"تعذّر التحقق من السجلات المتاحة.",
  },
} as const;
export type SupervisorLocale=keyof typeof copy;
export const goalLabel=(domain:RequestedGoal["domain"],locale:SupervisorLocale)=>copy[locale][domain];
export const unavailableGoalText=(domain:RequestedGoal["domain"],locale:SupervisorLocale)=>
  goalLabel(domain,locale)+": "+copy[locale].unavailable;
