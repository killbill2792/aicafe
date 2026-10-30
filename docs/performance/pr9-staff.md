# Performance PR 9 — Staff schedule first load

## Scope and status
This change overlaps an independent **read-only** external planned-shift fetch with the
existing internal roster queries in the canonical `getWeekSchedule` reader. It does
not change which shifts count as approved, paid or confirmed, nor does it modify
rule-alert synchronization, approvals, week selection, tabs or Toast import code.

The Staff page now reports privacy-safe `[reader-timing]` stages:
`Staff.requireOwnBusiness`, `Staff.staffReadScope`,
`Staff.getWeekSchedule`, `Staff.syncStaffRuleAlerts`; the canonical schedule
reader reports `Staff.getWeekSchedule.records` and
`Staff.getWeekSchedule.external`. These only log stage labels, duration,
random request correlation and the existing short-lived navigation trace.
They do not log people, café IDs, dates, money, shift content or URL parameters.

## Before / after
**Observed Staff browser p75/p95: unavailable, N=0 before and after.**
The Vercel runtime log endpoint returned HTTP 403 on Oct 30, so there is
no defensible real-café Staff stage or browser baseline in this session.
Do not treat existing Home/Money reader durations as Staff measurements.

**Verified dependency improvement (test fixture, not production latency):**
Before, the external planned-shift read could not start until the internal
roster batch had finished. After, it starts while the internal employee
read is deliberately unresolved; the regression test checks that ordering
and verifies unchanged internal shifts, team and external shift separation.
For successful reads, the two-stage portion of the request changes from
`internal_ms + external_ms` to `max(internal_ms, external_ms)`, subject
to normal server scheduling. This is a critical-path relationship,
**not** a measured p75/p95 or a guaranteed savings.

## Measurement / release gate
After explicit owner-approved deployment to an authenticated test café,
collect >=20 sampled warm and cold Staff navigations on a named phone
and desktop/network, including switching weeks, switching tabs, a slow
read and an external POS read failure. Group sampled `[nav-timing]`
`route=staff` by device/session for N, p50, p75, p95 TTFB/usable/feedback,
RSC request count and timeout rate. Separately calculate p75/p95 for each
Staff server stage and correlate the sampled request trace.
Compare before/after using the **same** fixture/device/network and
record whether roster or external POS was truly the dominant stage.

The Staff PR 9 progress box stays unchecked until required build/tests,
real comparative measurements and scheduling/action regression checks
are green. If a different stage dominates, scope it as a separate follow-up
instead of silently widening this PR.
