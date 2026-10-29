# 01 — Product

`AGENTS.md` sections 1–5 are the binding summary. This page adds detail. If they conflict, AGENTS.md wins.

## What it is
An **AI operator for independent café owners**. The owner talks to one AI assistant (the Supervisor chat),
and it runs the café for them: it answers, plans, drafts, monitors and reports back. The owner makes the
decisions; the AI does the work and follows up.

- Web app first (desktop and phone browsers). Native phone app later.
- The Supervisor chat is the main interface. Long term it is the only one; existing screens stay until the
  chat covers what they do.

## The questions it must answer and act on
- "How much money did I actually keep, and why?" (true profit after every cost)
- "What should I do about it?" (prices, staffing, suppliers, costs)
- "Do it for me, and tell me how it went." (schedules, experiments, follow-ups)

## Who uses it
| Person | What they need | Implication |
|---|---|---|
| Owner, 45–70, not tech-comfortable, may prefer Arabic or Spanish | One clear answer, plain words, big text, reassurance | Short answers, icons + words, language switch always visible |
| Owner, 30–45, busy | Answers in 10 seconds, between customers | Answer first, details behind a tap; the AI reports without being asked |
| Shift manager | Staffing, breaks, today's pace | Same chat, scoped to what they may see |
| New café owner (pre-launch or first months) | Costs, break-even, pricing, no sales history yet | Everything must work from owner inputs alone |

## What the operator handles
Every item works through the chat. Money numbers come from `lib/metrics/core`.

1. **True owner profit**: any period. POS sales minus everything: ingredients, staff (wages + payroll taxes),
   card fees, rent, utilities, insurance, loan, software, supplies.
2. **Cost recovery and break-even**: which bills this month's sales have covered, sales needed per day,
   live progress, what-ifs.
3. **Costs**: every cost line grouped, estimates tagged, missing costs flagged, comparison with last month,
   health check against healthy café ranges.
4. **True cost and profit per item**: ingredients + staff time + card fee + share of bills.
5. **Pricing and price experiments**: current price and margin, the effect of a change, a monitored test
   with mid-run updates and a final report. The owner changes the POS price; the AI tracks the result.
6. **Scheduling, end to end**: availability, coverage rules, a drafted week with labor cost, owner approval,
   publish, then copy-ready staff messages with a WhatsApp/SMS button the owner taps.
7. **Supplies and purchases**: inventory signals, purchase proposals, receipt and invoice capture.
8. **Easy cost capture**: monthly bills, bank statement upload with AI categorizing, receipt photos, voice
   entry, manual entry.
9. **Proactive monitoring**: the AI watches sales, costs, labor, coverage and missing data, and reaches out
   with what happened, why it matters and a suggested next step.
10. **POS connection**: Toast and Square (read-only), CSV upload for others.
11. **Onboarding**: connect POS, add bills, add top recipes, choose language, in about 15 minutes.

## How the owner sees what is going on
- **Operating Board** (top of the chat): key numbers, needs attention, running experiments and monitors
  (day X of Y, early read), recent reports.
- **Inbox and notifications**: every proactive finding, experiment update and report, with an unread count.
  In-app now; email next; browser push after; WhatsApp/SMS once a verified business sender exists.

## Limits for now (see AGENTS.md section 2)
- The AI never changes POS prices or menus. The owner does it and confirms in chat.
- The AI never sends messages to staff or suppliers directly. It prepares copy-ready text with a send button
  the owner taps, until a verified business WhatsApp/SMS sender exists.
- Anything with an effect needs the owner's approval each time. "Always allow" per action type comes later.
- The AI never moves money.

## Don't build
- Standalone sales reports, rankings or trends that only repeat what the POS already shows. Use that data
  inside chat answers instead.
- A separate screen or a separate calculation for something the chat already does.
- A general payroll processor, physical inventory counting app, or POS clone.

## Later
- Email, browser push, then WhatsApp/SMS delivery of reports.
- "Always allow" per action type.
- Direct staff messaging once a verified sender exists.
- Month-end P&L export for the accountant, QuickBooks sync, bank feed, multi-location.

## Success for the pilot
- The owner uses the chat at least 4 days a week without being reminded.
- The owner can say, unprompted, what their true profit was last month.
- At least one decision is made and followed through in the chat (a price test, a schedule, a supplier change),
  with the AI reporting the result.
