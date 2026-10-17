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
  fn("declare_request_scope", "FIRST business-turn action: semantically enumerate every supported owner sub-question as a separate goal. Pure planning metadata, never reads records; NOT a café-data tool. Required alongside read calls or before them. Max five goals. Include null comparison_period/comparison_from/comparison_to except for comparisons; comparisons require BOTH specified period selections. For omitted cost or labor periods default EACH goal to month_to_date, unless owner explicitly provided a period. Include total_business_costs separately from staff_cost, menu_count, pricing_review; do not collapse them into one domain.", {
    goals:{type:"array",minItems:1,maxItems:5,items:{type:"object",additionalProperties:false,
      properties:{domain:enumField(["total_business_costs","staff_cost","menu_count","pricing_review","owner_profit","profit_margin","monthly_bills","recorded_spending","sales","distinct_products","staffing","team","break_even","overview","owner_rules","comparison","staff_attendance","staff_schedule","schedule_preview","staff_coverage"]),
        period:dateFields.period,from:dateFields.from,to:dateFields.to,
        comparison_period:{type:["string","null"],enum:[...dateFields.period.enum,null]},
        comparison_from:dateFields.from,comparison_to:dateFields.to},
      required:["domain","period","from","to","comparison_period","comparison_from","comparison_to"]}},
  }),
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
  fn("get_financials", "Canonical owner profit and operating profit margin (owner profit divided by verified net sales), total business costs, monthly bills, actual expenses, break-even, and cost detail. An operating margin is not an ingredient-only margin.", {
    metric: enumField(["owner_profit", "profit_margin", "total_business_costs", "monthly_bills", "recorded_spending", "break_even", "cost_breakdown"]), ...dateFields,
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
  fn("olivia_availability", "Resolve an employee by name to their recorded availability state before scheduling. ALWAYS call this to resolve a name (e.g. 'Sarah') to an exact employee before using olivia_schedule what_if with that person. If more than one employee matches, ask the owner which exact person they mean instead of guessing.", {
    employee_name: nullableText,
  }),
  fn("olivia_schedule", "Olivia's real seven-day scheduling optimizer. action=preview computes a fresh proposed schedule for the Monday-starting week using recorded availability and coverage, with real costs and gaps; NEVER saves or publishes anything. action=what_if recomputes against a temporary hypothetical overlay (an employee unavailable for a window, or lower weekly/daily hours) and reports the real before/after difference; it NEVER invents more availability than recorded. Resolve any employee name via olivia_availability FIRST to get their employee_id.", {
    action: enumField(["preview", "what_if"]),
    week: { type: "string", description: "Monday of the target week, YYYY-MM-DD." },
    objective: { type: ["string", "null"], enum: ["cash", "owner_time", "balanced", null] },
    overrides: { type: ["array", "null"], maxItems: 20, items: { type: "object", additionalProperties: false,
      required: ["kind", "employee_id", "local_date", "start_local", "end_local", "overnight",
        "max_weekly_minutes", "max_minutes"],
      properties: {
        kind: enumField(["temporary_unavailable", "reduce_weekly_minutes", "reduce_daily_minutes"]),
        employee_id: { type: "string", description: "Exact employee id from olivia_availability." },
        local_date: { type: ["string", "null"], description: "YYYY-MM-DD within the requested week; required for temporary_unavailable and reduce_daily_minutes, null for reduce_weekly_minutes." },
        start_local: { type: ["string", "null"], description: "HH:mm; omit (null) for a full-day temporary_unavailable." },
        end_local: { type: ["string", "null"] },
        overnight: { type: ["boolean", "null"] },
        max_weekly_minutes: { type: ["integer", "null"] },
        max_minutes: { type: ["integer", "null"] },
      } } },
  }),
  fn("alex_pricing_review", "Alex's real menu pricing review: exact recorded selling price, ingredient-only cost, cost ratio and ingredient-only contribution per product, from authoritative recipe or owner-entered total cost evidence. Use all_active with pagination (offset/limit, max 25 per page) to review the whole menu; use specific_name only when the name is unambiguous, otherwise ask which exact product/size. Never invents a cost or price.", {
    selection: enumField(["all_active", "specific_name", "specific_id"]),
    product_name: nullableText,
    product_id: { type: ["string", "null"] },
    offset: { type: "integer", minimum: 0, maximum: 500 },
    limit: { type: "integer", minimum: 1, maximum: 25 },
  }),
  fn("alex_pricing_what_if", "Alex's real pricing what-if: apply ingredient cost/price/quantity/substitution changes to ONE product using its actual recorded recipe, and/or an owner-selected target cost ratio or ingredient margin, or a selling-price change. Reports the real before/after ingredient cost and contribution delta. Never writes a price or recipe; purely conditional. Resolve the exact product first with alex_pricing_review if the name could be ambiguous.", {
    product_name: nullableText,
    product_id: { type: ["string", "null"] },
    changes: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
      required: ["kind", "ingredient_id", "from_ingredient_id", "to_ingredient_id",
        "multiplier_basis_points", "cost_per_base_unit_micros", "package_cost_cents",
        "package_count", "package_unit", "quantity_value", "quantity_unit"],
      properties: {
        kind: enumField(["ingredient_multiplier", "ingredient_unit_cost", "supplier_package",
          "replace_ingredient", "set_quantity"]),
        ingredient_id: { type: ["string", "null"] },
        from_ingredient_id: { type: ["string", "null"] },
        to_ingredient_id: { type: ["string", "null"] },
        multiplier_basis_points: { type: ["integer", "null"], description: "13000 means ingredient cost rises 30%." },
        cost_per_base_unit_micros: { type: ["integer", "null"] },
        package_cost_cents: { type: ["integer", "null"] },
        package_count: { type: ["integer", "null"] },
        package_unit: { type: ["string", "null"], enum: ["gal", "fl_oz", "ml", "g", "each", null] },
        quantity_value: { type: ["number", "null"] },
        quantity_unit: { type: ["string", "null"], enum: ["g", "ml", "fl_oz", "each", null] },
      } } },
    selling_price_delta_cents: { type: ["integer", "null"] },
    selling_price_replace_cents: { type: ["integer", "null"] },
    target_cost_ratio_bps: { type: ["integer", "null"], description: "e.g. 2500 means target 25% ingredient cost ratio." },
    target_ingredient_margin_bps: { type: ["integer", "null"] },
  }),
];


// Exact production Responses function schemas. Imported by server registry and optional live eval. No secrets/data.
