# Staff proposal tools — intentionally NOT registered in PR #155

No generic `ai_proposals` approval-card storage/render/approve endpoint exists on
the mainline streaming-agent contract. Registering actions before a durable owner
approval boundary would allow AI-written changes without explicit authorization.

When the shared approval card is available, implement these tools as
**propose-only** (never commit directly), with owner-scoped, strict zod schemas,
compact preview results, stale revision detection and an owner-click commit that
reuses the corresponding `lib/actions` function:

- [ ] `propose_schedule`
- [ ] `propose_shift_change`
- [ ] `propose_add_staff`
- [ ] `propose_staff_change`
- [ ] `propose_availability_change`
- [ ] `propose_rule_change`
- [ ] `propose_send_schedule`

`parseAvailabilityText` returns an inert structured proposal for owner review.
It does **not** mutate staff availability and must not be wired directly to
`updatePerson` until the approval card is implemented.
