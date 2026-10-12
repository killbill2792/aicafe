const enumField = (values) => ({ type: "string", enum: values });
const nullableText = { type: ["string", "null"], maxLength: 120 };
const dateFields = {
  period: enumField(["today","yesterday","week_to_date","previous_week","month_to_date","previous_month","last_7_days","last_28_days","custom"]), from: { type: ["string", "null"] },
  to: { type: ["string", "null"] },
};
function fn(name, description, properties) {
  return { type: "function", name, description, strict: true,
    parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } };
}
export const SUPERVISOR_FUNCTIONS = [
  fn("get_cafe_overview", "Bounded operating overview: current trusted sales/profit states and Team attention count. No raw database.", { focus: enumField(["today", "month_to_date"]) }),
  fn("get_sales", "Read ACTUAL recorded transactions in a period, not products offered on the menu. distinct_products is the number of different items purchased in VERIFIED item-level order lines; it needs explicit period-based sold-item intent and complete coverage. For generic products the café sells/carries/offers, choose get_menu. Observed incomplete days are partial, never complete totals.", {
    metric: enumField(["net_sales", "orders", "units", "distinct_products"]),
    group_by: enumField(["total", "day", "product", "category"]), ...dateFields,
    category: enumField(["all", "drink", "food"]), product_name: nullableText,
    sort: enumField(["highest", "lowest"]), limit: { type: "integer", minimum: 1, maximum: 15 },
  }),
  fn("get_menu", "Read the MENU CATALOG: how many products/items the café sells, carries, offers or has on its menu, without a transaction period. For generic product counts including 'selling so far', 'currently sell' and 'currently offer', use view active_count, scope active. 'So far' alone does not establish a transaction period. Only use get_sales distinct_products when the user explicitly asks which DISTINCT products were actually purchased during a period. Active means listed, not necessarily physically in stock.", {
    view: enumField(["count", "active_count", "category_summary", "products", "product_details"]),
    scope: enumField(["all", "active"]), product_name: nullableText,
    limit: { type: "integer", minimum: 1, maximum: 15 },
  }),
  fn("get_financials", "Canonical modeled owner profit, total business costs, full recurring monthly bills, actual expenses, break-even status, or cost detail. Do not conflate expense types.", {
    metric: enumField(["owner_profit", "total_business_costs", "monthly_bills", "recorded_spending", "break_even", "cost_breakdown"]), ...dateFields,
  }),
  fn("get_staff", "Employee-domain records: recorded current attendance, staffing, labor and persisted coverage issues. NOT AI Team agent tasks. Missing schedules remain unknown.", {
    view: enumField(["current_staffing", "attendance", "schedule", "labor_cost", "coverage_issues"]), ...dateFields,
  }),
  fn("get_team", "AI Team persisted tasks, active signals, and decisions, distinct from human staff facts.", {
    status: enumField(["all","needs_you","handled","watching"]), agent: enumField(["all","alex","olivia","maya","leo"]),
    view: enumField(["tasks", "signals", "decisions"]), limit: { type: "integer", minimum: 1, maximum: 10 },
  }),
  fn("get_pricing", "Review-only canonical pricing-engine recommendation coverage. Distinguishes verified recommendations, verified ZERO review-ready changes, and products whose missing inputs block evaluation. Use for any question about price revisions; select returned count/insight ids, including zero and blocked evidence. Never calculate or invent a replacement price.", {
    product_name: nullableText, limit: { type: "integer", minimum: 1, maximum: 10 },
  }),
  fn("compare_periods", "Compare two café-local periods with server-computed differences. Supported: net sales, orders, loaded labor, canonical owner profit and costs. Incomplete coverage disallows a definitive direction.", {
    metric: enumField(["net_sales","orders","loaded_labor","owner_profit","total_business_costs"]),
    current_period: dateFields.period, current_from: dateFields.from, current_to: dateFields.to,
    comparison_period: dateFields.period, comparison_from: dateFields.from, comparison_to: dateFields.to,
  }),
  fn("conversation_control", "Only for greeting, genuine clarification or unrelated unsupported requests. NEVER use for business advice or café questions; those must use grounded data tools.", {
    intent:enumField(["greeting","clarification","unsupported"]),
  }),
  fn("get_owner_rules", "Active approved rules only; never expose drafts.", { agent: enumField(["all","alex","olivia","maya","leo"]) }),
];


// Exact production Responses function schemas. Imported by server registry and optional live eval. No secrets/data.
