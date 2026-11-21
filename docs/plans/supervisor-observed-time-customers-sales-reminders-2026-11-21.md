# Owner-reported Supervisor gaps — problem record only (2026-11-21)

**Status:** Problem inventory for discussion. **No architecture, data model, implementation scope, remediation owner, or acceptance design is approved by this document.** No runtime or test code is changed in this PR. This is independent of PR551's PostgreSQL WASM packaging repair.

## Context / evidence boundaries

The owner shared four iPhone screenshots from the live AI Cafe interface on November 21, 2026, and explained a later reminder exchange. The screenshots show an existing café profile with **Pacific Time — Los Angeles** selected, San Francisco as the address city, and an existing Supervisor chat. The café's identifying street address and full name are intentionally not reproduced in this public problem brief. Screenshot observations and owner statements are separated below; server logs, Toast API payloads, stored rows, agent tool calls and reminder execution logs **have not been inspected for these particular incidents**.

## Observed or reported problems

### A. Supervisor does not use the configured café's local time for a relative reminder

**Screenshot:** The owner asked the Supervisor to remind them **in 30 minutes** about total sales received by then. The Supervisor replied that it could not set the reminder accurately because it did not have the café's current local time and asked for a specific San Francisco time. Another screenshot shows the café profile already has the Pacific / Los Angeles time zone.

**Owner follow-up (not shown as verified action receipt):** The owner later supplied an ordinary clock time and the Supervisor said it had created a reminder. Whether it was persisted, when it is due, which delivery surface it uses, and whether it actually fires remain **unverified**. A conversational acknowledgement must not be counted as delivery proof.

**Problem to establish:** Why a known café time zone and a relative duration were insufficient; whether the result saved a real, correctly scheduled owner-scoped reminder; and whether the owner receives a visible acknowledgement and delivery at the expected time.

### B. Customers and repeat-customer names are missing or unavailable in Supervisor answers

**Owner report:** Customer information is not available when requested. The owner recalls a recent PR intended to extract cardholder names for identifying repeat customers, but repeated-customer names still are not shown.

**Not established:** Which customer/cardholder data Toast actually exposes to this integration or grants for this café; which permitted fields the importer retains; whether cardholder extraction was implemented, merged and backfilled; whether repeat-customer identity can be established reliably or legally from available data; whether the relevant records are readable by the registered Supervisor. No customer's payment-card or personally identifying data should be pasted into this PR.

**Problem to establish:** Source availability, authorized retention, freshness, matching reliability, customer privacy, and why an owner question currently fails to produce an appropriately sourced answer or an honest explanation of missing data.

### C. Hourly sales are not available to the Supervisor

**Owner report:** The Supervisor cannot answer questions requiring sales broken down by hour. The owner believes Toast may provide this information but does not know whether AI Cafe imports, stores or retains the necessary records.

**Not established:** Toast API grant, requested fields, local timestamps, business-day boundary, missing/refunded/voided orders, storage/rollups, refresh schedule, or actual registered Supervisor query coverage.

**Problem to establish:** Whether hourly sales are genuinely absent from the source, lost or stale during ingestion, unavailable through the agent's admitted tools, or incorrectly summarized.

### D. Wastage and cost recommendations have material gaps

**Screenshot:** For a question about last month's wastage and improving profit, the Supervisor said the inventory-variance read failed; it could not reliably calculate the wastage amount. It also stated ingredient costs were missing for **55 menu items** and that the reported **$50.38** of recorded ingredient costs was incomplete. A separate profit response showed an estimated calculation with a source label and a "Not checked against your records" notice.

**Not established:** Which failure caused the inventory read, whether inventory records are present, why recipe ingredient costs are missing, whether the source labels reflect actual query receipts, and what expense conclusions remain safe.

**Problem to establish:** Correct partial-data disclosure, reliable source attribution, and whether the Supervisor can make useful recommendations without presenting an incomplete number as complete wastage/profit.

## Questions to investigate before deciding architecture or scope

1. Which parts can be reproduced on a signed-in owner account and which are one-off or stale responses?
2. Which relevant Toast fields are actually offered, authorized, ingested, stored and available to registered Supervisor tools for this café, without exposing customer identifiers?
3. What data provenance, as-of timestamps, currency, café-specific clock and permissions were attached to the actual failing tool calls?
4. Was the reminder persisted with the correct café-local due time and owner identity? Was it executed, retried, delivered or failed? What should the owner see in the existing interface?
5. Which prior PRs covered cardholder extraction/customer identity, hourly sales, inventory variance and scheduled reminders, and what did those PRs *actually* verify?
6. Are these separate source/ingestion, tool/agent, scheduler/effect, or presentation failures? **Do not choose the architecture in this problem-report PR.**

## Decision boundary

- [x] Record the owner-observed symptoms and separate screenshots from unverified assertions.
- [x] Keep this as a documentation-only **draft** problem report.
- [ ] Review evidence and agree on architecture, owning PRs, specific data/privacy boundaries, implementation paths and executable acceptance scenarios **in a later owner decision**.
- [ ] Only after that decision, authorize implementation and independent live/source/effect testing.

**No claim of a completed fix, trustworthy customer identity, hourly Toast coverage, or delivered reminder is made here.** Existing Task17B (all registered Supervisor tools, data/source and metrics), Task17C (off-turn reminders/restarts/effects) and Task17D (owner browser experience) are context for later coordination, not automatically authorized coding owners of this new problem.
