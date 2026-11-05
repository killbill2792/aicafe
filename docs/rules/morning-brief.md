## 4c. Morning brief: every café, every day, before it opens
A brief that never sends is worse than a brief with one line missing.
- **Per-café send time.** From the café's timezone and that day's opening time (`locations.open_hours`):
  send as soon as yesterday's POS data is complete, and no later than 30 minutes before opening. Close to
  that time, send anyway with what we have. Unknown or unusable hours use 06:00 café time, and the record
  says so. One code path: `lib/operating/briefSchedule.ts`. Never a fixed clock window for every café.
  Exactly one brief per café, owner and local date.
- **The 24-hour WhatsApp rule is only for free text.** The brief is an approved Meta template and is sent
  whatever `lastOwnerMessageAt` is. A later free-text follow-up goes on WhatsApp only inside the window
  (`whatsappFreeTextAllowed` / `withinWhatsAppServiceWindow` in `lib/whatsapp/supervisor.ts`, the only
  implementation); outside it, skip WhatsApp or use a template.
- **Menu labeling is its own job** (`/api/cron/menu-labels`), independent of the brief and of WhatsApp.
  A labeling failure is logged and retried next run; it never blocks anything.
- **Never block on a missing extra.** Net sales, items sold, best seller and one event line are always
  filled; a missing fact says plainly that it is not in yet, never a zero. Drink-only counts only when every
  sold category is labeled, otherwise all items. Events: today's (any source; verification only softens the
  wording), else the next one within 7 days, else "No major events near you this week." (only when that
  week's research completed). Skip only when there is truly nothing to say.
- **No silent skips.** Every skip or block is recorded with its step and reason in `morning_brief_runs`
  (`/admin/briefs`). A `return null` on the brief path without a recorded reason is a P1.
  A Meta 4xx is saved as `provider_rejected:<code>[/<subcode>] <Meta's title>` (digit runs masked, no
  message content), so the outbox row says why Meta refused.
- **Meta template wording is fixed.** Template names, blank order and buttons live only in
  `lib/whatsapp/briefTemplates.ts`. Blanks are never empty and never contain line breaks, tabs or 4+
  spaces. Never claim a watcher that does not exist.
