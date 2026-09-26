# 01 — Product

## The one question the app answers
"How much money did I actually keep, and why?"

Every feature must help answer that. If a feature only repeats what Square or Toast already shows, don't build it.

## Who uses it
| Person | What they need | Implication |
|---|---|---|
| Owner, 45–70, not tech-comfortable, may prefer Arabic or Spanish | One clear number, plain words, big text, reassurance | Default view is simple. Icons + words. Language switch always visible |
| Owner, 30–45, busy | Answers in 10 seconds, on the phone, between customers | Glanceable home, one-tap drill-down |
| Shift manager, Gen Z | Staffing, breaks, today's pace | Staff screen, quick actions, optional detail mode |
| New café owner (pre-launch or first months) | Costs, break-even, pricing, no sales history yet | Cost per drink and break-even must work from inputs alone |

## Pilot scope (version 1): build all of these
1. **True owner profit**: Today / Week / Month. POS sales minus everything: ingredients, staff (wages + payroll taxes), card fees, rent, utilities, insurance, loan, software, supplies.
2. **Cost recovery**: this month's money "fills" each expense in order (rent first, then utilities, and so on). Show the day each one was covered, plus "today in cups". The owner can reorder the expenses. This is the signature feature.
3. **Profit & costs breakdown**: every cost line grouped, estimates tagged, missing costs flagged, comparison with last month, health check against healthy café ranges.
4. **True cost per drink**: per menu item, ingredients + staff time + card fee + share of rent & bills = true profit per drink. Also "extra money from one more drink".
5. **Break-even**: drinks needed per day, live progress today, what-if scenarios (price, one less shift, milk price).
6. **Easy cost capture**: monthly bills entered once; bank statement upload (CSV/PDF) with AI categorizing and reasons; receipt photo reading; voice entry ("paid 400 for electricity"); manual entry.
7. **POS connection**: Square OAuth (read-only). Toast and any other POS via CSV export upload in v1.
8. **Onboarding**: connect POS, add monthly bills, add top recipes, choose language. Must be doable in 15 minutes sitting with the owner.

## Version 1.5
9. "Why today was different": a plain-language explanation of what moved profit.
10. Staff cost view: cost per minute now, per person today, staff cost per $1 by hour.
11. Weekly text message summary: the top 3 money things (SMS or WhatsApp).
12. Arabic and Spanish fully translated and reviewed by native speakers.

## Later
13. Month-end P&L export (PDF/CSV) with receipts attached, for the accountant.
14. QuickBooks sync (read expenses, write daily sales summary).
15. Ingredient price tracking from receipt lines ("milk up 70¢ a gallon").
16. Plaid bank feed.
17. Toast API.
18. Multi-location.
19. Scale/sensor integration.

## Don't build (Square/Toast already do it)
- Standalone sales reports, item rankings, sales trends
- Standalone void, overtime, or break alerts as a main feature (they may appear as supporting cards inside our screens)
- A general "ask your data" chatbot
- Scheduling, payroll, inventory counting

## Success for the pilot
- The owner opens it at least 4 days a week without being reminded.
- The owner can say, unprompted, what their true profit was last month and when rent was covered.
- At least one decision is made from it (a price change, shift change, or supplier change).
