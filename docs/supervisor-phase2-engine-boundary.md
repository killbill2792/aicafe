# Supervisor Phase 2 — trusted café tool boundary

The Supervisor is not a generic chat endpoint. Its **only** intended café-data access is the allow-listed `BusinessScopedCafeTools` created by `createAuthenticatedCafeTools()` on the server.

## Flow

Authenticated owner → active café membership → `createAuthenticatedCafeTools()`
→ `BusinessScopedCafeTools` (no caller-supplied business IDs)
→ `StructuredCafeTools`
→ `SnapshotCafeStateService`
→ **existing** `getSnapshot()` and `getMenuControlCenter()`
→ **existing** `lib/calc` engine results + source quality.

The data/decision client stays inside the authenticated server composition. Do not hand an AI provider the Supabase client, a generic SQL tool, an arbitrary businessId parameter, or a full document store.

## Current tool truth table

| Tool | Source | Validity |
|---|---|---|
| `getCafeSummary` | Existing café snapshot, month-to-date | Contains observed slices plus explicit missing/estimate evidence |
| `getProfitability` | Existing `lib/calc` owner profit, total costs and running-cost proration | Available only for fully sales-covered supported periods with essential cost inputs; cents and exact period |
| `getSalesTrend` | Actual sales-covered daily rollups | No trend if any calendar date lacks sales coverage |
| `getProductEconomics` | Snapshot product cost with existing recipe/owner-total precedence | Missing/estimated product cost labeled; unknown product unavailable |
| `getPricingRecommendation` | `getMenuControlCenter()` canonical pricing engine result | No new formula, no fabricated recommendation; benchmark is not verified market evidence |
| `getExpenseSummary` | Existing monthly cost lines, prorated via pure running cost engine | Period lines sum exactly to the same rounded aggregate as profitability |
| `getExpenseChanges` | Not yet connected to matched prior-period expense history | Unavailable (`previousExpenseHistory`) rather than falsely showing current bills as a change |
| `getLaborMetrics` | Existing daily rollups including staff-only dates | Loaded wages/taxes only; estimated taxes flagged |
| `getInventoryStatus` | No verified inventory quantities | Unavailable; never infer in-stock/low-stock |
| `getActiveSignals` | Existing deterministic pricing signal calculation | Raw evidence signals, not owner-actionable persisted task statuses |
| `getDecisionHistory` | Existing RLS-scoped `cafe_decisions` | Read-only; rejects any returned cross-business record |

### Scope and limitations

- The current snapshot has authoritative bills for its *loaded month*, not an arbitrary historical month. Custom dates outside that month, beyond the as-of day, invalid dates, or ranges crossing a month return **unavailable**, not invented prior bill data.
- Missing sales days are not assumed to be zero-sales days. A partial observed sales slice may exist, but verified profitability and sales trends are unavailable until coverage is complete.
- Pricing cannot be treated as a historical observation when querying prior periods; it is loaded only in current state.
- Explicit missing card fees, missing expected recurring costs, and sold products without a resolved cost prevent a verified profitability result. Positive estimated costs, processing fees, payroll taxes, and estimated product costs remain labeled in `quality.estimatedInputs`.
- No data is written, no price is applied to POS, and no conversation, autonomous worker action, proactive task mutation, AI model call, or new Supabase migration is introduced in Phase 2.
- The existing persisted operating-task lifecycle is **separate** from raw deterministic signals. Future phases must retrieve actionable Needs You / Handled / Watching through that same task system; do not create a second inbox.

## Next phase

Add `ai_threads` / `ai_messages` with business/user scoping, auditable structured messages and permissions. Only after that add a grounding router that selects the typed tools above and validates every answer against available evidence. The UI composer is intentionally still disabled in Phase 2.
