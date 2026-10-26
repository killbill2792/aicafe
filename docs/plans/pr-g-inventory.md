# PR G — Inventory, purchases, and drink consistency

Status: implementation in progress on draft PR #194. Transactional purchases, proposed chat purchases, Inventory history, per-line approvals, and source-scoped modifier linking are coded, but end-to-end DB/owner acceptance verification remains required.

## Integration

PRs C/D/E/F/H are merged on main; PR G is now based directly on `main`.
Keep all their prior Home, Chat, Supervisor and CSV changes when rebasing.
PR I independently reserves migration 099. PR G therefore contains a single
additive migration: `20261027000100_inventory_purchases.sql`. Re-check if main moves.
Do not apply production migrations or merge this PR.

Read AGENTS.md and docs/02-design-system.md before implementation.
The requested /workspace/prE-attention-staff-match.md,
/workspace/prF-new-chat-team-cards.md and /workspace/self-review-snippet.md
were not available in this checkout when this draft was opened.

## Implementation contract

1. Shared sales evidence and modifiers
   - Owner-only security-definer sales coverage RPC, maximum 31 days,
     covering imported/synced days from any provider, including zero-sales days.
   - Read all non-excluded, non-superseded sales; replace toastSalesCoverage
     with salesCoverage in calculation, presentation, and translations.
   - Normalize every adapter and optional CSV modifier column to
     {posModifierId, name, quantity, priceCents, parentPosModifierId}.
     Missing historical quantity defaults to one; no historical rewrite.
   - Preserve nested modifiers once and multiply recipe deltas by modifier
     and sold-line quantities. Keep provider branches outside pure calculations.
   - Scope modifier IDs by provider and restaurant/location; fail closed on
     conflicting mappings and preserve sized milk swaps.

2. One purchases pipeline
   - Extend pantry_stock_purchases with stable line_id, unique business/line ID,
     source, source_ref, cost_cents, expense_line_id, updated_at and voided_at.
     Backfill existing source to manual; owner updates, members read.
   - recordPurchases validates owner/non-demo scope and ingredient conversion,
     converts entered quantities to base units, upserts each independent line,
     and returns per-line errors. Reuse shared ingredient-price writing logic.
   - Route manual, bulk, receipt page, receipt chat, typed chat and purchases
     CSV through this writer. Receipt stock links to expense_lines; retry must
     recover incomplete stock writes without duplicating expenses or prices.
   - Define the typed PurchaseSource adapter contract for future QuickBooks
     and bank feeds, without building either connector.
   - Add a regression guard against direct purchase inserts outside the writer.

3. Existing Pantry becomes Inventory
   - Cafe-local calendar month picker; purchase rows with entered/base units,
     formatted cost, source labels and per-ingredient non-voided totals.
   - Edit/void purchases, add/edit counts, bulk rows with independent outcomes,
     receipt review link and mapped purchases CSV upload.
   - Drink consistency card uses one tested missing-code/i18n mapping for
     count, recipe/modifier link and sales-import next steps.

4. Existing approval lifecycle
   - Verify and wire authorized attached images into the agent turn within
     existing attachment limits; never expose another owner's attachments.
   - propose_purchases creates one inert proposal per line, no silent new
     ingredients. Maya is only a label. Register the existing loop capability.
   - Reuse SupervisorProposalCard and per-proposal compare-and-set tokens:
     Approve/Edit/Skip, independent retry, sequential Approve all with per-line
     results, and Inventory review of the same proposal set.
   - Approval alone calls recordPurchases with proposal-stable line_id.
     Double taps and retries cannot duplicate lines or invalidate siblings.

5. Fill clarification
   - Extend ask_owner/contracts with fill fields, numeric input and unit select.
   - Parse Spanish decimal commas and Arabic digits; inputMode decimal.
   - Only ask once per turn for missing inputs returned by usage tools.
     Purchase answers create proposals; count answers use the count writer.
   - Collapse answered card to a single localized formatted summary.

6. Confirmed modifier suggestions
   - Read observed modifiers and available Toast/Square catalogs; score by
     normalized name and unit against modifier recipes and product addons.
   - Never one-tap an ambiguous candidate or link automatically.
   - Inventory and chat confirmation use the same source-scoped mapping write.
     New mapping table requires explicit static RLS for each action.

## Required acceptance coverage

- [ ] Square-only expected/actual usage, no Toast requirement.
- [ ] Toast and Square double-shot quantities and nested modifiers counted once.
- [ ] Ten chat receipt lines: three approved, one failed/retried independently,
      six still actionable; batch retries cannot duplicate stock.
- [ ] Page/chat receipt stock equivalence; one expense; linked expense lines.
- [ ] Typed four-gallon purchase converts through ingredient conversions.
- [ ] Cafe-timezone month boundaries and non-voided monthly totals.
- [ ] Fill inputs: English, Spanish comma, Arabic digits, once-per-turn guard.
- [ ] Repeated CSV upload, approval and Approve all are idempotent.
- [ ] Unique and ambiguous modifier suggestions; confirmation resolves usage.
- [ ] No direct purchase writer elsewhere.
- [ ] Existing pantry DB workflow tests owner/member/cross-business RLS.
- [ ] Every new key in en/es/ar; mobile EN/AR screenshots; RTL and 48px targets.

## Review and completion gate

Run meaningful regression tests, full tests, lint, typecheck, build and diff
checks. Inspect new SQL in the disposable pantry DB workflow; no dynamic RLS
loops. Search for related Toast-only gates and dropped modifier quantities.
Check raw colors and split number/currency formatting in the full diff.

Push; verify remote HEAD and expected commit count. Fetch and read every line
of origin/main...origin/branch cold. Classify findings, fix all P1s in one round,
re-run verification and push. Record findings, fix SHAs and remaining P2s in
PR Self-review. Do not mark ready or request Codex before completion.

Final PR body must include owner before/after screenshots (Inventory, receipt
cards and fill card in EN/AR), final migration filename, and read-only SQL for:
purchases by source/month, duplicate line IDs, receipts missing purchases,
and unlinked modifier counts. Merge note: after PR F; rebase on D if merged.
