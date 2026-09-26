# 03 — Screens

Visual references are in `design/mockups/`. Where a mockup and this doc disagree, **this doc wins**.
All numbers come from `lib/calc/` (see `05-calculations.md`). Demo data = the "demo café" fixture.

## Navigation
Bottom tabs: **Home** · **Money** · **Menu** · **Staff** · **More**
- Home = Overview
- Money = Cost recovery (top) + Profit & costs (below), with a segmented switch at the top
- Menu = Cost per drink
- Staff = Staff cost
- More = Break-even plan, Alerts, Monthly bills, Uploads, Settings
- Floating "Add cost" button on Home and Money opens the Add cost sheet.

Period switch (Today / Week / Month) at the top of Home and Money. Default: Month on Money, Today on Home.

---

## S1. Welcome and language
Mockup: `connect.html` (adapt)
- First screen: three big language buttons (English / Español / العربية) with the words in their own language.
- Then: headline "See how much money your café really keeps", one line "Connect your register. We'll do the math."
- Trust line with shield icon: "We only read your sales and timecards. We never change anything or touch your money."

## S2. Onboarding (15 minutes, with the owner)
A 5-step wizard with a progress bar (steps are a real sequence, so numbered dots are fine). Each step can be skipped and finished later; skipped steps create "missing" banners.
1. **Connect your register**: "Connect Square" (OAuth) or "I use Toast / something else" (goes to CSV upload help with screenshots).
2. **Your monthly bills**: a list of big icon tiles (Rent, Electricity & gas, Water, Internet, Insurance, Loan, Software, Other). Tap a tile, type the monthly amount, done. Show "Most cafés have these" as a hint, not a requirement.
3. **Your staff costs**: pulled from POS. Owner confirms wages look right and sets payroll tax % (default 12%, explain in one line).
4. **Your top drinks**: for the 10 best sellers (from POS), confirm ingredients per drink from a template (latte = 18g espresso + 10oz milk + 12oz cup + lid). Supplier prices entered once (milk per gallon, beans per lb, cups per sleeve). Prep time per drink from template (drip 30s, latte 90s, specialty 120s), editable.
5. **What gets paid first?** Drag to order expenses for cost recovery. Default: Rent, Staff*, Utilities, Insurance, Loan, Software, Supplies. (*Staff is paid per cup by default; see calculations.)
End: "You're set. Here's your café this month." → Home.

## S3. Home (Overview)
Mockup: `overview.html`
Top to bottom:
1. Header: café name, date, Live dot, language switch.
2. Period switch.
3. **Hero card (green): Owner profit** for the period, "Estimate" pill if any estimate is included, change vs same point last period with arrow.
4. **Three tiles**: Sales / Total costs / You keep, each with $ big and % small.
5. **Cost recovery strip**: the expense icons in a row, each filled to its % covered, with a caption like "Rent ✓ Sep 7 · Utilities ✓ Sep 8 · Insurance 60%". Tap → Money tab, Cost recovery view.
6. **Today in cups card**: "Today's 212 cups paid $398 toward insurance & loan." After all covered: "Every cup today is yours. A latte makes you $2.75."
7. Section cards (tap to open): Profit & costs, Menu (best and worst earner), Break-even (need vs average), Staff (cost per minute now), Alerts (count + $ leaking).
8. Missing-cost banner if any category is empty this month.

## S4. Money → Cost recovery (signature screen)
Mockup: `cost-recovery.html`
1. Hero sentence, depending on state:
   - Not all covered: "Next up: insurance & loan. 60% paid back." + "At your pace, everything's covered by about the 11th."
   - All covered: "All of this month's bills are covered. Since the 11th, everything you make is yours." + "$3,000 yours so far."
2. **Expense list in payment order**: each row = large filling icon, name, monthly amount, status: "✓ Covered Sep 7" / progress bar + "$600 to go" / "Waiting". Drag handle to reorder (saves order, recalculates instantly).
3. **Month calendar strip**: one cell per day. Past days filled green (money went to bills) or darker green with coin icon (money was yours). A small expense icon sits on the day each expense got covered. Future days are outlined and show projected cover dates, dashed.
4. **Today in cups**: row of cup icons (1 icon = 20 cups) colored by which expense they paid. Caption in words.
5. **Explainer (collapsed)**: "How this works: each cup first pays for its own milk, cup, card fee and staff time. What's left goes to your bills, in the order you chose. Once they're all paid, it's yours." Month-end profit is identical either way; say so.
6. Milestone toast when an expense becomes covered: "🎉 Rent covered for September, 3 days faster than August."

## S5. Money → Profit & costs
Mockup: `profit.html`
1. Step-down chart: Sales → minus Ingredients → minus Staff → minus Rent & bills → You keep. Horizontal bars, colors from tokens, $ labels.
2. Grouped list:
   - **Sales** (source + order count)
   - **Ingredients & cups** (with change vs last period)
   - **Staff**: Wages, Payroll taxes
   - **Rent & bills**: Rent, Card fees, Insurance/loan/software, Electricity & gas (Estimate pill + Edit), Supplies, Missing rows with Add button
   - **Total costs**, **Owner profit** (green highlight)
3. "Costs entered: 7 of 9 this month."
4. Health check: Ingredients %, Staff %, Ingredients + staff % with a healthy band (see calculations) and one plain sentence each.
5. vs last period: 3–5 biggest changes in $, with arrows, ending in the Owner profit change.
Every row taps into its individual entries (receipts, statement lines, recurring bill), each editable.

## S6. Menu (true cost per drink)
Mockup: `menu.html` (update it: add the rent & bills layer)
1. Featured item card (best seller): stacked bar with 5 segments: Ingredients, Staff time, Card fee, Rent & bills share, **Yours** (green). Dollar label inside each segment where it fits, legend below.
2. Two numbers under it, side by side:
   - "You keep per latte: **$2.08**" (after everything)
   - "Each extra latte adds: **$2.75**" (after ingredients, card fee, staff time)
   One line: "Your rent is fixed, so every extra cup adds $2.75. The rent share per cup gets smaller as you sell more."
3. All items list: name + price, thin stacked bar, "You keep" value. Sort: by money kept per cup (default) or by total money kept this month.
4. Insight card (one at a time): best earner to push, lowest earner to reprice, with $ impact per month.
5. Tap an item → recipe editor (ingredients, amounts, prep seconds) and price-change simulator ("Price $5.25 → $5.50 adds $290/month at current sales").

## S7. Break-even plan (More)
Mockup: `break-even.html`
1. Big number: drinks per day needed to cover everything, plus "about N an hour".
2. Where it comes from: rent & bills per day, planned staff per day, average money left per drink, the division shown.
3. Today's progress bar toward it (live).
4. What-if rows: raise all prices 25¢, one less person 2–5 PM, milk up $1/gal. Each shows the new drinks-per-day number. Tapping opens sliders.
5. For new cafés with no sales: uses planned staff and expected average price.

## S8. Staff (v1.5, but build the data now)
Mockup: `staff.html`
Cost per minute / per hour / today so far (wages + payroll taxes). On shift now: person, role, since, cost today, break due flag. Staff cost per $1 of sales by hour with a healthy line at 30¢. One insight sentence.

## S9. Alerts (supporting)
Mockups: `alerts.html`, `alert-detail.html`
Only alerts that explain money: unusual voids/refunds, missed meal breaks (CA rules), early clock-ins, underpriced item, overstaffed slot, missing bill. Each shows $ impact and one action. Never accusatory wording.

## S10. Add cost (sheet)
Mockup: `add-cost.html`
Four big options: Photo of receipt · Upload bank statement · Say it · Type it.
- Photo: camera → "Reading…" → extracted vendor, date, total, lines, suggested category → "Looks right" / "Fix".
- Statement: pick file (CSV or PDF) → parsed lines grouped by suggested category with a reason per line ("PG&E → Electricity & gas, matched vendor name") → "Save all" / fix individual lines. Show the balance check result.
- Say it: hold-to-talk → transcript → parsed amount/category → confirm.
- Type it: amount keypad first, then category tiles, date defaults to today.

## S11. Monthly bills (More)
List of recurring costs with icon, amount, frequency, next due. Edit in place. "Actual this month" entry to replace an estimate.

## S12. Settings (More)
Language · Café name and timezone · Payroll tax % · Card fee source (from POS by default) · Cost recovery order · Detail mode toggle · Connected register (reconnect/disconnect) · Team access (invite manager with limited view: no profit numbers unless owner allows) · Export data · Delete account.

## Global states
- Loading: skeleton cards in the same layout, never a blank screen or spinner alone.
- POS disconnected: warn banner at top with Reconnect button.
- No data yet (new café): each section shows what it needs and a button to add it.
