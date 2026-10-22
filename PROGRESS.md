## Now
- [ ] Review M1: generic owner goals/experiments, check-ins, monitoring, approval and RLS; run CI and live smoke before merge.
- [ ] Deploy approved M0/M1 migrations separately; neither is applied by this PR.
- [ ] Run a live owner agent smoke test with credentials before production release.

## Next
- [ ] Review eight-theme UI foundation for screen contrast and owner RTL behavior.
- [ ] Add an actual owner-click approval card and persistence in UI; only then enable production propose_initiative registration (backend-only M1 deliberately gates it).
- [ ] Add staff WhatsApp check-in handling in W2; no staff messaging in M1.
- [ ] Add rolling conversation summaries and remove unused legacy routes.

## Done (last 10)
- PR #147 merged: team_updates owner-scoped storage and service-role writer.
- PR #146 merged: streaming agent with bounded calls and verified money extraction.
- Existing P1 source inventory and business data boundary remain enforced.
