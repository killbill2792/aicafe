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
  "lib/data/fixtureSnapshot.ts":{
    getFixtureSnapshot:{restricted:"Demo/testing fixture is not authenticated real café evidence"},
  },
  "lib/data/getActiveBusinessId.ts":{
    getActiveBusinessId:{restricted:"Trusted session selector; not a model-readable business record"},
  },
  "lib/data/getActiveCafeName.ts":{
    getActiveCafeName:{capabilities:["business.profile"]},
  },
  "lib/data/getAlerts.ts":{
    getOpenAlerts:{restricted:"Owner alert rows need a bounded typed source/status projection"},
    getAlertById:{restricted:"Alert-by-ID requires owner-scope and separate evidence policy"},
  },
  "lib/data/getCatalogMatchReview.ts":{
    getCatalogMatchReview:{restricted:"Raw POS mapping review contains private import identity metadata"},
  },
  "lib/data/getIngredientNames.ts":{
    getIngredientNames:{capabilities:["menu.ingredients"]},
  },
  "lib/data/getPosConnectionStatus.ts":{
    getPosConnectionStatus:{restricted:"Provider connection/sync metadata require separate owner-only contract"},
  },
  "lib/data/getProcessingFeeEstimateSetup.ts":{
    getProcessingFeeEstimateSetup:{restricted:"Private processing-fee assumption settings need provenance"},
  },
  "lib/data/getProductPhoto.ts":{
    getMenuCatalogPhotos:{restricted:"Product asset URLs require a separately authorized media contract"},
    getProductPhoto:{restricted:"Product image metadata are not a canonical numeric record"},
  },
  "lib/data/getUploadHistory.ts":{
    getUploadHistory:{restricted:"Private uploaded statement/receipt history needs safe evidence redaction"},
  },
  "lib/data/materializeSchedule.ts":{
    ensureScheduledShiftsThroughDate:{restricted:"Materialization writes timecards; P1 never invokes this effect"},
    ensureTodayScheduledShifts:{restricted:"Materialization writes timecards; P1 never invokes this effect"},
  },
  "lib/data/materializeScheduleRules.ts":{
    localDatesInclusive:{restricted:"Pure date helper is not a business-data reader"},
    selectSchedulesForDate:{restricted:"Internal schedule selection helper, not a public owner projection"},
  },
  "lib/data/monthCalendar.server.ts":{
    getMonthCalendarFromDb:{restricted:"Internal broad Money view model; canonical typed metrics are separate"},
  },
  "lib/data/periodItemSales.server.ts":{
    readPeriodItemSales:{capabilities:["sales.item_units","sales.item_coverage"]},
  },
  "lib/data/queryError.ts":{
    logQueryError:{restricted:"Internal private error logger, not a read capability"},
  },
  "lib/data/runningCostCatalog.ts":{
    rowToDailyFacts:{capabilities:["sales.daily"]},
  },
  "lib/data/snapshot.server.ts":{
    getBusinessSnapshotFromDb:{restricted:"Private unbounded composite DB snapshot; use typed scoped projections"},
  },
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
  "lib/data/teamUpdates.server.ts": {
    insertTeamUpdate:{restricted:"Service-role owner-inbox write; not a model-readable business metric"},
    selectTeamUpdates:{restricted:"Private owner-scoped team update inbox; not a P1 numeric source"},
    updateTeamUpdateStatus:{restricted:"Owner-only status mutation; not a read capability"},
  },
  "lib/data/operatingTasks.ts": {
    syncAndGetOperatingTasks:{restricted:"Task reconciliation writes are not read-only P1 capabilities"},
    readPersistedOperatingTasks:{capabilities:["team.tasks"]},
  },
  "lib/ai/policies/repository.server.ts": {
    SupabaseTeamRulesRepository:{capabilities:["team.owner_rules"]},
  },
  "lib/scheduling/foundation.server.ts": {
    requireSchedulingOwner:{restricted:"Internal owner membership/session guard; not a model-visible read capability"},
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
  "lib/data/pantry.server.ts": {
    listPantry:{restricted:"Owner-scoped pantry and supplier cost inventory; no direct agent read contract"},
    addFromStarter:{restricted:"Writes starter ingredients; requires explicit owner action and tenant checks"},
    savePackPrice:{restricted:"Creates effective-date supplier pricing; not a read-only agent capability"},
    previewPriceImpact:{restricted:"Owner-requested hypothetical margin preview; not an authorized agent source"},
    applyTemplate:{restricted:"Replaces size-family recipes; requires explicit owner action"},
    swapIngredient:{restricted:"Mutates all matching recipe sizes; not a model-readable source"},
    scaleRecipeToSize:{restricted:"Mutates a target recipe; not a model-readable source"},
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
  olivia_availability:{restricted:"Olivia's own authenticated staff_availability_* reader (executeOliviaReadCapability), independent of the P1 canonical metric catalog"},
  olivia_schedule:{restricted:"Olivia's own authenticated PR2/PR3 scheduling optimizer and what-if overlay (executeOliviaReadCapability), independent of the P1 canonical metric catalog"},
  alex_pricing_review:{restricted:"Alex's own domain-owned alex.pricing.batch_review.v1 P2 registration, independent of the P1 canonical metric catalog"},
  alex_pricing_what_if:{restricted:"Alex's own domain-owned alex.pricing.what_if.v1 P2 simulate registration, independent of the P1 canonical metric catalog"},
} as const satisfies Record<string,Surface>;
