import type { SupportedId } from "./p1Catalog";

/**
 * Review-bound snapshot of all exported canonical owner/UI/business readers
 * checked during P1 implementation. Independent source-code scanning in tests
 * fails on additions/removals/renames; deliberately limited to reviewed public
 * modules rather than unrestricted database discovery.
 *
 * Each symbol must be mapped to an authorized P1 catalog ID, or explicitly
 * restricted with a reason. These classifications never grant runtime access.
 */
type Surface = {capabilities:readonly SupportedId[]} |
  {restricted:string};
export const SOURCE_SURFACES = {
  "lib/data/getCafeProfile.ts": {
    getCafeProfile:{capabilities:["business.profile"]},
  },
  "lib/data/getMenuItemsForEdit.ts": {
    getMenuItemsForEdit:{capabilities:["menu.recipe","menu.ingredients"]},
  },
  "lib/data/getMenuControlCenter.ts": {
    getMenuControlCenter:{capabilities:["pricing.recommendation","menu.product_economics"]},
  },
  "lib/data/getEmployees.ts": {
    getEmployees:{capabilities:["labor.employee_wages"]},
  },
  "lib/data/getStaffSchedules.ts": {
    getStaffSchedules:{capabilities:["labor.recurring_assignments"]},
  },
  "lib/data/getSnapshot.ts": {
    getSnapshot:{restricted:"The broad mutable snapshot is intentionally projected through bounded P1 money/sales readers"},
  },
  "lib/data/getRecurringCosts.ts": {
    getRecurringCosts:{capabilities:["money.monthly_bills","money.recurring_bill_rows"]},
  },
  "lib/data/getMonthCalendar.ts": {
    getMonthCalendar:{restricted:"Owner calendar view-model contains aggregate projections; source underlying registered money readers"},
  },
  "lib/data/operatingTasks.ts": {
    syncAndGetOperatingTasks:{restricted:"Task reconciliation writes are not read-only P1 capabilities"},
    readPersistedOperatingTasks:{capabilities:["team.tasks"]},
  },
  "lib/ai/policies/repository.server.ts": {
    SupabaseTeamRulesRepository:{capabilities:["team.owner_rules"]},
  },
  "lib/scheduling/foundation.server.ts": {
    executeFoundationCommand:{restricted:"Scheduling foundation writes require independent enablement and cannot be model-executed"},
    readSchedulingFoundation:{capabilities:["labor.availability_foundation"]},
  },
  "lib/ai/cafeTools.server.ts": {
    createAuthenticatedCafeTools:{restricted:"Owner-bound facade factory; not a model-callable business data reader"},
    readSupervisorCafeIdentity:{capabilities:["business.profile"]},
  },
  "lib/ai/conversations/toolRegistry.server.ts": {
    parseSupervisorCalls:{restricted:"Legacy model tool validator remains unchanged until P2"},
    intentForCalls:{restricted:"Legacy classification utility, not business data"},
    createSupervisorToolRegistry:{restricted:"Production legacy router is out of P1 execution scope"},
  },
  "lib/operating/cafeState.ts": {
    SnapshotCafeStateService:{restricted:"State loader requires scoped projections; not a model-visible generic record dump"},
    cafeStateFromSnapshot:{capabilities:["money.profitability","money.business_costs","sales.daily","labor.daily_costs"]},
  },
  "lib/data/getPricingInputs.ts": {
    getPricingInputs:{restricted:"Raw pricing inputs may include cost internals; read through canonical pricing recommendation"},
  },
  "lib/data/getPayrollCostSettings.ts": {
    getPayrollCostSettings:{restricted:"Payroll tax configuration requires separate field authorization; no direct model output"},
  },
  "lib/data/getProfitGoalSimulatorData.ts": {
    getProfitGoalSimulatorData:{restricted:"Existing UI what-if input reader is not a P1 model simulation contract"},
  },
} as const satisfies Record<string,Record<string,Surface>>;

/** Independently authored coverage for all current model-visible tool names.
 * These execute only through the pre-existing trusted Supervisor, not P1.
 */
export const LEGACY_MODEL_TOOL_SURFACES = {
  declare_request_scope:{restricted:"Scope declaration has no domain data"},
  get_cafe_overview:{capabilities:["money.profitability","money.business_costs","sales.daily"]},
  get_sales:{capabilities:["sales.daily","sales.item_units","sales.item_coverage"]},
  get_menu:{capabilities:["menu.catalog","menu.product_economics"]},
  get_financials:{capabilities:["money.profitability","money.business_costs","money.monthly_bills","money.recorded_spending","money.break_even"]},
  get_staff:{capabilities:["labor.attendance","labor.current_staff","labor.recurring_assignments","labor.daily_costs"]},
  get_team:{capabilities:["team.tasks"]},
  get_pricing:{capabilities:["pricing.recommendation"]},
  get_owner_rules:{capabilities:["team.owner_rules"]},
  compare_periods:{capabilities:["sales.daily","money.profitability","money.business_costs","labor.daily_costs"]},
  conversation_control:{restricted:"No operational facts"},
} as const satisfies Record<string,Surface>;
