# D4C — Toast-first menu authority, owner review, and historical variant safety

**Status:** In Review — owner-approved *behavioral decisions* consolidated; detailed implementation choices and complete spec acceptance are pending.
**Date:** 2026-11-07
**Canonical handoff:** [Draft PR #398](https://github.com/killbill2792/aicafe/pull/398) (source/architecture), [Draft PR #400](https://github.com/killbill2792/aicafe/pull/400) (agent rules/task handoff).
**Execution owners (proposed):** POS0d for Toast menu sync/catalog semantics; POS0f for shared-reader and final integration proof. Menu UI/server-action file ownership and any common foundation changes must be assigned explicitly before coding. This is a design specification, not runtime authorization.

## 1. Problem and evidence

AI CAFE must not create a second published menu alongside an authenticated Toast-connected café. Onboarding should start with the Toast connection and automatically populate real published products, sizes, modifiers, prices, and category/group identity; the owner then contributes recipes, ingredient quantities/costs, and other enrichment. Today's code mixes manual and Toast items in the Menu's All/Needs attention/Archived view, supports local Add Item as immediately active, and can locally edit POS-controlled fields without writing them back to Toast.

Read-only audit, connected verified café on Nov 7: 57 Toast canonical size/item rows (53 active priced, four inactive unpriced), representing **45 active base products**; one extra active manual item **Dirty Esspresso 12 oz** with four recipe-ingredient lines and no provider identity; zero pending pos_catalog_matches reviews. The existing Needs attention tab is *recipe/price attention*, not legacy identity review. /menu/import-review reads inbound POS/CSV matches only, so merely hiding manual rows would strand saved recipes.

Historical Aug 22–Sep 28 sales: 563 Toast order lines across seven base GUIDs have null canonical menu_item_id, **not missing original sales**. All 563 have a stable POS line ID and matching retained raw order selection; 506 include original 12 oz/16 oz modifier labels and a historical group GUID not matching the current published size group. No automatic current-recipe assignment is justified by title, price, or modifier label alone. The existing menu importer may issue a duplicate full Menus V2 GET and may deactivate a provider-owned row based on an inadequately verified snapshot; those are POS0d correctness risks, not permission to create a parallel importer.

## 2. Goals, non-goals and anti-goals

**Goals (owner approved):**
1. Verified Toast publication is authoritative for what appears in the connected café's current published menu: official provider product/size/option/group identity, names, category/group, selling prices, availability and active publication state.
2. A new café can connect Toast with **zero owner-created menu rows**; its published products and their real options become visible without manual recreation.
3. Display **one provider-identity product group with its authentic published sizes/options** beneath it. Each size retains its own GUID, price and independently enriched recipe. Show a size label once, not twice.
4. Allow owner-managed recipes, ingredients, quantities, costs and approved presentation/enrichment without claiming those were published into Toast.
5. Owner-added products for a connected café save as **unpublished review drafts**. The owner sees **“Add this product in Toast to make it available on your live menu.”** Never present them as Toast-published until a real Toast publication and verified linking succeed.
6. Preserve existing unmatched manual and CSV products, recipes, price history, historical transactions and retired Toast sizes for review or historical queries. Confirmed Toast disappearance becomes **inactive, not hard-deleted**; same GUID republished reactivates.
7. Use existing change-driven menu metadata and an already scheduled coordinator, **not full menu polling every 10 minutes**, a second catalog, or a second scheduler. Failed/partial evidence never removes good menu items.
8. Menu screens, customer/published catalog and the **one Supervisor** apply the same source-authority/current-published distinction, while historical answers preserve source/as-of context.

**Non-goals:** Writing menu data back into Toast; manually recreating Toast's menu before connecting; automatically publishing owner drafts; silently merging records on name/price similarity; deleting historical records/recipes; guessing old size/recipe or sales amounts; launching D4B order-processing changes from this spec.

**Anti-goals:** A local draft leaking into the published menu, a bad/empty Toast response removing last-good items, a recipe moving to the wrong Toast size, misleading “verified profit” with unlinked cost, or blocking disconnected/manual cafés from their supported workflow.

## 3. Owner-approved architecture

~~~mermaid
flowchart TD
  A[Verified Toast connection] --> B[Existing 10-minute coordinator checks lightweight version/metadata]
  B -->|unchanged| C[Keep last verified published catalog]
  B -->|changed or bounded repair| D[One complete restaurant-scoped Menus V2 candidate]
  D --> E{Complete, consistent and authorized?}
  E -->|no| C
  E -->|yes| F[Existing catalog sync by Toast GUID; price/version evidence]
  F --> G[Published Toast-only Menu projection + current-menu Supervisor]
  H[Owner adds product/recipe] --> I[Owner review: unpublished]
  I --> J[Owner publishes product in Toast separately]
  J --> B
  F --> K{Verified identity and safe recipe relationship?}
  K -->|yes| L[Associate owner enrichment; preserve history]
  K -->|ambiguous| I
  L --> G
  F --> M[Confirmed missing provider item: inactive; owner review; no hard delete]
~~~

**Current published identity:** scope by verified business + Toast restaurant + actual Toast base item GUID; size identity is the exact Toast option GUID within its source group. Reuse existing menu_items, provider IDs/aliases, modifier_recipes, menu_item_modifier_groups, menu_price_history, toast_catalog_facts/versions and existing raw/current order evidence where appropriate. **Do not create a second raw menu/archive or competing published table.** The physical published/review projection and optional status metadata require a dependency audit and explicit later design acceptance.

**Source-boundary rule:** provider-controlled fields remain Toast-owned. A locally stored owner alias, recipe or picture does not change a Toast publication, real size price, real modifier or provider identity. The current matchCatalogItem heuristic that can accept unique manual name+size+price must **not** silently assert a true Toast-to-manual identity or transfer a size recipe without independently verified linkage. Exact source GUID/approved alias wins; otherwise present a candidate to the owner and retain the draft. The exact review confirmation threshold remains **OPEN** (section 8).

**Owner review and screen behavior:** For a verified connected Toast café, All/search/category, ordinary pricing/recipe Needs attention and published menus show only actually published Toast identity; Archived shows confirmed inactive Toast items (including unpriced). A separate, discoverable **Owner review** surface is recommended within the existing Menu tabs, using the existing /menu/import-review workflow where safe. It must also find pre-existing manual rows, which are not currently in pos_catalog_matches. Show saved recipes, current nonpublication status, possible Toast candidate with proof, instructions to publish in Toast, and explicit owner decisions. **Needs attention stays about pricing/recipes**; owner review is not a replacement. While the concrete tab/route mechanism is proposed, the owner-approved behavior is unambiguous: the review list is reachable from Menu and its drafts never leak into current published catalog. The existing Add Item path for a connected café must produce an unpublished draft; a disconnected/manual café keeps its normal manual editing flow.

**Publication/removal:** A complete authenticated, restaurant-scoped, consistent published snapshot can add/update active Toast options. A disappearance may mark provider publication inactive **only after completeness and independent confirmation**; preserve all historical identities, prices, recipes and order lines. Republish with the same GUID reactivates. Empty/partial/stale/unpermitted/mismatched-version/missing referenced groups, publication lag or failed write is **not proof of removal**. Keep last-good published state and visible stale/failure evidence. No auto-delete; any owner-requested hard removal requires separate explicit approval and historical-dependency validation, with historical evidence retained.

**Historical sales:** Original Toast order item/selection/modifier GUIDs are authoritative for what was purchased on that date. Today's 12 oz/24 oz catalog is **not** proof of an older 16 oz recipe. Keep all 563 source sales queryable; reconcile to historical variants only with dated source/alias/owner-confirmed evidence, not title or amount guesses. Incomplete size→recipe relationships make dependent ingredient usage, cost/COGS and profit **partial**, never fabricated zero/fully verified.

## 4. Current code and data touchpoints (audit before implementation)

- Menus fetch/version and staging: lib/pos/toast/optionalSync.ts, adapter.ts, operationalStaging.ts, operationalCopy.ts. Reuse version metadata and fix multiple full GETs only in a separately accepted implementation.
- Catalog keys, matching, archive: lib/pos/catalogMatching.ts, syncCatalog.ts; menu_items, modifier_recipes, menu_item_modifier_groups, pos_item_aliases, pos_catalog_matches, toast_catalog_facts and price-version/history tables. Validate per-restaurant and per-version identity/relationship completeness.
- Menu UI/readers: app/[locale]/menu/page.tsx; components/menu/MenuCatalog.tsx; lib/viewmodels/menuCatalogViewModel.ts; lib/data/getMenuItemsForEdit.ts, getMenuControlCenter.ts, getUnpricedPublishedMenu.ts, getCatalogMatchReview.ts; app/[locale]/menu/import-review/page.tsx and app/[locale]/menu/[itemId]/page.tsx. Current All loads manual/Toast together; Archived omits unknown-priced rows; grouping by **baseName alone** may conflate different real provider identities if future duplicates appear.
- Actions/gates: lib/actions/menuItems.ts (Add Item, local activate/deactivate, rename and price edit), lib/actions/catalogMatches.ts. UI-only filters are insufficient: enforce no unauthorized publication on direct server action/deep link.
- Consumers: lib/ai/supervisorReads.server.ts menuCatalog, cv_menu, published/customer-facing menus, Home/pricing panels and cost/usage/rollup/metric quality readers. Do not apply a broad published-only filter to all canonical/historical/recipe queries: they need archived/manual evidence for review and history.
- Existing legacy connected café manual example: Dirty Esspresso 12 oz has **four recipe lines** and no saved Toast GUID. Toast has a similarly titled Dirty Espresso product; do not assume they are one size/recipe.

No code, schema or production record is changed by this document. Exclusive path/table ownership and exact migration/rollback contract are not yet approved.

## 5. Failure handling and STRIDE threat model

| STRIDE / failure | Risk | Required boundary / test |
|---|---|---|
| Spoofing | Owner manually claims Toast-published identity | Publication only from verified restaurant-scoped Toast API + durable validated snapshot; no draft-to-published toggle |
| Tampering | Local action overwrites Toast name/price/availability or steals GUID | Server action and DB-level source rules; tenant-scoped identity/alias validation; no silent recipe transfer |
| Repudiation | Owner or sync cannot explain draft match/unpublish/republish | Auditable confirmation, source restaurant/version, action actor, as-of evidence, retained previous state |
| Information disclosure | Another café's menu/recipes show in review or Supervisor | Authenticated active-business scope, per-location authorization, RLS and negative cross-café tests |
| Denial of service / data loss | Partial/menu-empty/stale response retires real item; two GETs create churn | Version/completeness guard, independent disappearance verification, last-good, bounded retry, rate limit adherence |
| Elevation of privilege | Direct link/server action publishes draft or edits provider-owned fields | Source-aware backend gates, owner roles, RLS/privileged RPC review, no security-by-hidden-tab |
| Integrity / historical mismatch | Old size modifiers linked by display name/price | Historical GUID/version proof; explicit unknown cost status; no rewriting original transaction money |

## 6. Alternatives considered

**A. Owner-first or blended publication:** manual and Toast items all appear in All if locally active. **Rejected by owner:** creates a competing published catalog, duplicates and misleading status.

**B. Toast-first published view + separate owner enrichment/review (selected and approved):** source-authentic published menu, one product/multiple real sizes, owner drafts preserved but unpublished until Toast confirms; owner recipes attach only after evidence-backed identity association. Stronger safety, minor review overhead.

**C. Drop all manual records on Toast connection:** superficially simpler but destroys owner recipes/history and contradicts explicit nondeletion approval. Rejected.

**UI shape:** repurpose Needs attention (confuses pricing with publication identity) versus dedicated Owner review entry/tab reusing the existing review route (recommended; exact wireframe/route still to be confirmed).

## 7. Implementation handoff, rollout and measurable verification (NOT authorized yet)

1. **Foundation check:** inventory current schema/RLS, verified Toast location state, legacy manual ownership, current-menu and historical readers. Resolve exact published predicate, rollback, restaurant/version proof and exclusive PR/file ownership; coordinate POS0d with POS0e shared reader and POS0f proof. No queue approval flag, dispatcher activation, cron or PROGRESS edit.
2. **Contained behavior:** implement a source-aware published-menu projection and owner-review discovery/reconciliation reusing existing entities; guard server actions and direct links; preserve disconnected/manual café behavior. Never force \`is_active=false\` just to hide a draft from published view.
3. **Source correctness:** one complete menu fetch on proven change/repair, ID-true catalog import, owner recipe preservation, inactive-on-verified-removal, reactivation and historical variant archive.
4. **Test matrix:** newly connected empty café imports without owner menu entry; unchanged version fetches **zero** full menus; actual change fetches once; malformed/empty/lagging/wrong-restaurant/403/missing-option responses preserve last-good; same GUID republished yields one identity; manual Add Item persists review-only with no published leak; former active legacy record enters review preserving all recipe lines; no Toast publication keeps it there; publish+sync+verified link moves it into the one published item; ambiguous name/price never transfers recipe; unpriced archived Toast item is reviewable; other café cannot see or act on it; local edit/activate direct action cannot spoof Toast; historical sales and 563 orphaned variant lines remain visible without fabricated COGS; actual one-Supervisor/menu-screen parity.
5. **Evidence gate:** use a disposable database at the current migrated schema for writes/migrations, source-shaped Toast fixtures and real registered Supervisor/screen assertions. In production, read-only verification and explicitly approved reversible rollout only. Record case-by-case pass/fail, last-good behavior, rollback and no duplicate records. Success = zero unpublished legacy cards in published views; no lost recipe lines/order money; no unverified hard deletion; one displayed card per verified base Toast product; source-scoped correctness and tenant isolation.

## 8. Decisions and open questions

**Approved by owner:** D4A change-driven menu download, not every scheduler tick; Toast-first auto-population; Toast controls published products/price/sizes/modifiers; one product with separate size options; owner enriches recipes/costs; unmatched manual or owner-added product stays in Owner review, with “Add this in Toast” guidance; never publish locally before Toast actually publishes; owner can link to a verified Toast product; confirmed absence → inactive, not deleted; republished same GUID restores; retain historical data and existing order values; one Supervisor/screen authority.

**Open #1 — NEXT OWNER DECISION (identity proof for draft recipe transfer):** When a later Toast-published item looks like the owner draft but the draft had no Toast GUID, do we **always request explicit owner confirmation** before attaching its recipe to a specific Toast product/size (recommended), or permit automatic linking if a proposed strong identity proof is independently defined and tested? Names/prices/size labels alone are *not* sufficient evidence.

**Open #2 — detailed design:** Exact current-published status/read contract; physical representation of owner draft/review status, including older manual rows and existing pos_catalog_matches; dedicated tab versus link; owner review disposition choices and any notification counts.

**Open #3 — implementation safety:** Which existing code/SQL paths and PR exclusively own each field/reader/action; what represents validated publication completeness and independent unpublish confirmation; whether a schema migration is necessary; tenant/RLS/rollback and observable stale status.

**Open #4 — history:** Which dated menu and recipe version evidence exists for each older modifier GUID; how unprovable mappings are grouped for owner review, and where cost confidence flags surface. Never infer a present-day size from an older price.

**Design review checklist:** problem, goals, constraints, architecture, alternatives, failure modes, STRIDE, test/rollout and measurable outcomes documented; fresh independent builder review not available in this chat, so perform a line-by-line self-check and request owner spec acceptance before code. Local methodological support files assets/spec-template.md, assets/threat-model.md, builder-check-prompt.md and superpowers:writing-plans were not supplied; equivalent required sections above are provided manually. **Status cannot advance to Accepted or implementation-queue approval until owner signs off and the remaining build-changing questions are resolved.**
