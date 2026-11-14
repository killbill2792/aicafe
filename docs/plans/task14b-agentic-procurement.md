# Task 14B — Agentic Supervisor purchasing implementation contract

> **OWNER NON-NEGOTIABLE:** AI CAFE is **not a Q&A chatbot**. Supervisor is one persistent, proactive, multi-step agent that takes purchasing work off the café owner. It must investigate evidence, plan, execute authorized steps, verify outcomes, remember pending work and reach out when attention is needed. Do not declare Grokbot/Muse operational parity without a separately executed side-by-side benchmark. Passing deterministic CI alone is not parity proof.

## Owner-approved flow
1. An owner's natural-language supply goal or an authorized operational signal starts work inside the **existing Supervisor**, not a separate purchasing bot.
2. Supervisor reads **canonical café inventory/ingredient evidence** and stored supplier quotes (with dates, verified currency, pack sizes, delivery/availability and provenance), identifies missing fields and declines to guess. It can investigate and explain several alternatives and adapt to a correction.
3. Supervisor computes comparable purchase quantities and exact integer-cent line totals, separating unknown delivery/tax from known prices. It prepares a **persistent immutable proposal/PO draft** for review and surfaces a specific approval action.
4. Only an owner approval through the **existing proposal/effect gateway** can promote the order to approved-for-ordering. The write has durable idempotent proof and history. A retry must never create two orders; a stale revision must not be approved.
5. Task 14C owns supplier outreach/placing the external order. Task 14D owns receiving/invoice reconciliation. **No stock, inventory-cost or expense write from Task 14B.**
6. Supervisor records what was actually done; no external order or delivery is claimed. Reuse the existing Operations inbox, follow-up tasks, durable worker and Task 15A anomaly detection for autonomous triggers rather than introducing another queue/agent.

## Source → canonical record → use
| Source | Trust contract | Saved | Business key |
|---|---|---|---|
| Owner-recorded supplier quote | supplier, exact item, pack quantity/unit, currency confirmed or unknown, quoted date, source and URL, optional availability and expiry | existing `ai_supplier_quotes` + additive fields | existing business+owner+request UUID |
| Supplier identity | owner verified, normalized within one café; do not merge merely similar names | `cafe_suppliers` | business+supplier UUID |
| Owner purchasing goal | owner-bound thread, ingredient IDs, needed date, requested quantities, explicit source refs | existing `supervisor_proposals` immutable canonical effect | existing thread+request key |
| Approved PO | immutable quote/price/quantity/currency snapshots; subtotal; explicit unknown charges; history and approval evidence | new `purchase_orders`, `purchase_order_lines`, `purchase_order_events` | business+proposal ID / request key |

## File ownership / integration
14B owns the supplier quote schema/route/UI, purchasing calculation, PO tables + RPC, Supervisor capability and agent tool, proposal approval presentation, Task 17A purchasing acceptance, unit/db/security/agent/E2E tests. It reuses Task 14A's canonical inventory reader, Task 10's gateway, Task 12's documents, Task 17A's runner, existing attention & durable worker. It never edits PROGRESS.md, stock purchase writer, expenses ledger, external Gmail send, Toast, or production configuration.

## Explicitly required acceptance
- Owner asks once for a supply plan → real multistep tool calls → grounded supplier comparison → saved draft/proposal → clear approval; owner changes quantities → new correctly bound revision rather than silent second PO.
- Owner approval → gateway receipt → exactly one approved PO with immutable line/history and exact currency; second click, concurrent retry or replays do not duplicate.
- Missing/stale/ambiguous supplier evidence **blocks** unsupported confident recommendation. No public search snippet is treated as a confirmed quote.
- Never increment stock, record an expense, or send a supplier message in 14B. Cross-café IDs and untrusted document instructions cannot approve effects.
- Task 17A selection executes real purchasing regression tests; real database, browser and recorded agentic acceptance are separate, visible gates. Report executed proof by SHA, and explicitly mark unavailable live-model/provider parity as unverified.

## Rollback
Additive tables/columns only; leave existing quote API and inventory behavior unchanged until new capability is proven. Disable new tool exposure on validation failure; retain durable order and gateway history for reconciliation. Production release/migrations require separately authorized rollout.
