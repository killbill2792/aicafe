# Reported Supervisor gaps: café time, Toast data and reminders

**Source:** Owner-supplied AI Cafe mobile screenshots and accompanying report, November 21, 2026. **Status: symptoms to investigate; not independently reproduced; no architecture or implementation approved.** This PR is documentation-only and must remain a draft until the owner decides next steps.

## Observations and questions (not confirmed root causes)

1. **Café local time.** The saved café profile shows **Pacific Time — Los Angeles**, while the Supervisor refuses “remind me in 30 mins about total sales,” saying it lacks current café local time and asking the owner to specify San Francisco time. The screenshot does not establish whether time context, a current clock, settings loading or tool registration failed.
2. **Reminder persistence and delivery.** After providing a normal/absolute time, the owner reports the Supervisor said the reminder was created, but it is unknown whether a persisted reminder exists, whether it will execute, where any notification is delivered (chat, push, otherwise), or how success/failure is confirmed. **A model's “created” statement is not a delivery receipt.**
3. **Hourly sales from Toast.** The owner expects hourly sales but cannot obtain them reliably. It is unknown whether the permitted Toast API/account exposes the necessary source data, whether ingestion/retention/aggregation captures it, or whether current registered Supervisor tools can answer.
4. **Customers and repeat visits.** The owner cannot see customer names/repeat customers, despite previous PR work described as extracting cardholder names. The live source fields, actual stored identity/matching behavior, authorized privacy constraints, completeness and tool/view availability are unverified. Do **not** infer customer identity from a card token or assume Toast provides names.
5. **Wastage and inventory read.** The October wastage screenshot states the inventory-variance read failed and ingredient costs are missing for **55 menu items**; the reported **$50.38** ingredient cost is explicitly incomplete. Root cause of the read failure and any missing source/recipe costs is unverified. Other labor/fee figures do not establish wastage.
6. **Source provenance and answer certainty.** The owner sees a profit estimate with a breakdown and “Not checked against your records,” raising the question of when facts are sourced, estimated or unverified. This does not prove the displayed financial numbers are incorrect.
7. **Concise notifications vs verified action.** The owner wants short notices, but also needs to distinguish a claimed action, a persisted routine/reminder, and actual delivery. Do not interpret short UI copy as evidence that an external effect occurred.

## What we can substantiate from supplied screenshots

- Saved profile: Seiyun Yemeni Coffee / Seiyun Cafe, USD, `Pacific Time — Los Angeles`, address in San Francisco.
- Supervisor's relative-time reminder refusal despite that saved timezone.
- Supervisor's incomplete October wastage response and its own disclosure of missing cost information.
- The later reminder acknowledgement, hourly sales problems and customer/repeat-name gap are **owner-reported**, not supported by independent records, logs or provider response inspection.
- Screenshots were supplied in the project conversation and are not copied to this repository; this document does not embed customer data or secrets.

## Unknowns for a later owner architecture discussion

- Which time source and timezone are authoritative for the current conversation and relative reminders?
- Was a reminder persisted, which existing scheduler executes it, and what delivery channel and receipt can be observed?
- What hourly sales/customer/cardholder data are permitted and available in Toast, which fields are actually persisted, and what are the privacy/matching rules?
- Why did the inventory-variance read fail? Where are the missing ingredient costs?
- What does “Not checked against your records” mean for each data source, estimate and cited answer?
- Which symptoms reproduce on an authorized café/account, without access to another tenant's data?

## Explicit non-scope / ownership

**No design, architecture, accepted scope, implementation, database/connector change, customer matching logic, notification channel or live test is approved in this PR.** The owner explicitly requested only the problem statement and will decide architecture and scope later.

This independent documentation PR does not alter or depend on serverless packaging PR551, staff PR550 or Task17's existing work. It must not be treated as implementing, testing or resolving any listed symptom.
