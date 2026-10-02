# 05 — Calculations (source of truth)

All functions live in `lib/calc/`, are pure, take integer cents, and have Vitest tests using the fixtures below.
Round only at the end of a calculation (half-up to the cent). Never round intermediate values.

> The mockups use approximate numbers (for example 281 drinks, $15,080). **The fixtures in this file win.**
> Update the demo seed and screens to show the fixture values.

## Definitions
| Name | Formula |
|---|---|
| Net sales | gross − discounts − refunds (excludes tax and tips) |
| Card fees | sum of POS processing fees (Square reports the fee per payment) |
| Effective fee rate | card fees ÷ net sales, over the last 28 days |
| Ingredients (theoretical) | Σ over order lines: quantity × recipe cost (recipe lines × current ingredient price, plus modifier deltas) |
| Wages | Σ timecards: paid hours × hourly wage (paid breaks count, unpaid breaks don't; open shifts count up to now) |
| Payroll taxes | wages × business.payroll_tax_rate (default 0.12) |
| Staff cost (loaded) | wages + payroll taxes |
| Running costs for a period | Σ over running-cost categories: monthly amount ÷ days in that month × days of the period that fall in that month |
| Monthly amount of a category | actual expenses recorded for that month if any exist, otherwise the recurring estimate. Label as estimate if any part is estimated |
| Total costs | ingredients + staff cost + card fees + running costs |
| Owner profit | net sales − total costs |

Supplies bought via receipts or statements are categorized as `supplies` (running cost) unless the lines are mapped to ingredients, in which case they update ingredient prices and do **not** add to costs a second time (ingredients are already counted from recipes). Flag the difference between purchased and theoretical ingredients as "difference from your recipes" (v1.5).

## Per-drink calculations
- **Staff cost per prep-second (for a day)** = that day's loaded staff cost ÷ Σ(prep_seconds × quantity sold)
- **Staff time per drink** = item.prep_seconds × staff cost per prep-second. For the Menu screen use the average over the last 28 days.
- **Card fee per drink** = price × effective fee rate
- **Rent & bills share per drink** = (this month's running costs ÷ days in month) ÷ average drinks per day (last 28 days)
- **Extra money from one more drink** = price − ingredients − card fee − staff time
- **True profit per drink** = extra money from one more drink − rent & bills share

Explain in the UI that the rent share falls as volume rises; the extra-money number doesn't.

## Break-even
- **Average money left per drink** = (net sales − ingredients − card fees) ÷ drinks, over the last 28 days
- **Daily costs to cover** = running costs per day + average daily staff cost (planned staff for new cafés)
- **Drinks needed per day** = ceil(daily costs to cover ÷ average money left per drink)
- What-ifs recompute with the changed input: price change applies to every item; "one less person 2–5 PM" removes 3 hours × that person's wage × (1 + tax rate) per day; milk change updates the milk ingredient price.

## Cost recovery (sequential fill)
Concept: each day's leftover money fills this month's expense buckets in the owner's chosen order.

Settings
- `staff_mode`: `per_cup` (default: staff is taken out every day before buckets, because staff is paid for the hours worked) or `bucket` (monthly staff total becomes a bucket at a position the owner chooses).
- Bucket order from `recovery_order`. Default: rent, utilities_power, water, internet, insurance, loan, software, supplies, repairs, other. Only categories with an amount this month appear.

```ts
type Bucket = { code: string; amountCents: number; isEstimate: boolean };
type DayContribution = { date: string; cents: number; projected: boolean };

// contribution for a day (per_cup mode) = net sales − ingredients − card fees − loaded staff
// in bucket mode: net sales − ingredients − card fees
function costRecovery(buckets: Bucket[], days: DayContribution[]) {
  let cumulative = 0;
  const thresholds = runningSum(buckets.map(b => b.amountCents)); // end of each bucket
  const coveredOn: (string | null)[] = buckets.map(() => null);
  for (const d of days) {                  // days sorted, actual first, then projected
    cumulative += d.cents;                 // negative days reduce cumulative
    thresholds.forEach((t, i) => {
      if (coveredOn[i] === null && cumulative >= t) coveredOn[i] = d.date + (d.projected ? '~' : '');
      if (coveredOn[i] !== null && cumulative < t && !d.projected) coveredOn[i] = null; // slipped back
    });
  }
  // report state as of the last ACTUAL day for percentages; use projected days only for forecast dates
}
```
Outputs
- per bucket: `pctCovered` (0–100), `centsToGo`, `coveredOn` (actual date) or `projectedCoveredOn`
- `currentBucket` (first not fully covered)
- `yoursSoFarCents` = max(0, cumulative_actual − Σ all buckets)
- `projectedMonthEndProfitCents` = cumulative including projected days − Σ all buckets
- Projected days use the average contribution of the same weekday over the last 4 weeks (fallback: last 14 days average).

**Today's contribution**: today's leftover money (the same per-day formula as above) assigned to whichever bucket(s) it lands in — it can finish one bucket and start the next in the same day. Once everything is covered, it's simply the owner's. Shown as a sentence ("Today's sales put $640 toward Rent — Rent is now 68% covered"), not per-unit icons: a "cup" isn't a meaningful unit for every business (bakery, restaurant), so nothing here is expressed per-cup.

Note for the UI: month-to-date **Owner profit** prorates running costs by days elapsed, while **Cost recovery** counts the whole month's bills from day 1. So on Sep 26, owner profit so far ($15,092) is higher than "yours so far" ($13,812). Both are right; they will be equal at month end. The cost recovery screen shows "On track for $17,414 this month" to connect them.

## Health check bands
| Measure | Healthy | Watch | High |
|---|---|---|---|
| Ingredients ÷ net sales | 25–35% | 35–40% | > 40% |
| Staff cost ÷ net sales | 25–35% | 35–40% | > 40% |
| Ingredients + staff ÷ net sales | < 60% | 60–65% | > 65% |

## Alert rules (supporting)
- **Missing bill**: a running-cost category with a recurring entry or last month's actual, but nothing recorded or estimated this month → warn.
- **Voids**: voids this month > 2 × average of the previous 3 months **and** > $100. Show share by employee. Wording: "worth a calm look, could be training."
- **Meal break (California)**: a non-exempt shift longer than 5 hours needs a 30-minute meal break starting before the end of the 5th hour. Warn at 4h30 with no meal break taken; record a likely penalty of 1 hour of regular pay per day missed. Show "This is general information, not legal advice."
- **Early clock-in**: clock-in more than 7 minutes before the scheduled start (needs Square scheduled shifts).
- **Overstaffed slot**: an hour-of-week where staff cost ÷ sales > 45% on at least 3 of the last 4 weeks.
- **Covered milestone**: when a bucket becomes covered, compare with the same bucket's covered day last month.

## Fixture A: demo café (seed + tests)
Month: September 2026 (30 days). Every day in the fixture is identical, for easy checking.
- Payroll tax rate 12%
- Per day: net sales **$2,400.00**, drinks **480**, ingredients **$650.00**, card fees **$70.00**, wages **$696.00** → payroll taxes **$83.52** → staff cost **$779.52**
- Daily contribution (per_cup) = 2,400 − 650 − 70 − 779.52 = **$900.48**
- Monthly running costs (bucket order): rent **$6,000**, utilities_power **$1,200** (estimate), insurance+loan+software **$1,500** (store as insurance $500, loan $700, software $300), supplies **$900** → total **$9,600** → **$320.00/day**

Expected
| Check | Value |
|---|---|
| Rent covered on | Sep 7 (cumulative day 7 = $6,303.36) |
| Utilities covered on | Sep 8 ($7,203.84) |
| Insurance covered on (threshold $7,700) | Sep 9 ($8,104.32) |
| Loan covered on (threshold $8,400) | Sep 10 ($9,004.80) |
| Software covered on (threshold $8,700) | Sep 10 |
| Supplies covered on (threshold $9,600) | Sep 11 ($9,905.28) — everything covered |
| As of Sep 9 end of day | current bucket = loan, 57.8% covered, $295.68 to go |
| Yours so far on Sep 26 | 26 × 900.48 − 9,600 = **$13,812.48** |
| Projected month-end profit (recovery view) | 30 × 900.48 − 9,600 = **$17,414.40** |
| Owner profit month-to-date on Sep 26 | 62,400 − 16,900 − 1,820 − 18,096 − 2,171.52 − 8,320 = **$15,092.48** |
| Total costs month-to-date on Sep 26 | **$47,307.52** |
| Owner profit today (any day) | 2,400 − 650 − 70 − 779.52 − 320 = **$580.48** |
| Average money left per drink | (2,400 − 650 − 70) ÷ 480 = **$3.50** |
| Drinks needed per day | ceil((320 + 779.52) ÷ 3.50) = ceil(314.15) = **315** |
| What-if all prices +25¢ | money left per drink 3.75 (fees held constant for simplicity in v1) → ceil(1,099.52 ÷ 3.75) = **294** |
| Rent & bills share per drink | 320 ÷ 480 = **$0.6667** |
| Health: ingredients | 27.1% healthy · staff 32.5% healthy · together 59.6% healthy |

(For the break-even fixture, daily costs to cover = running $320 + staff $779.52 = $1,099.52.)

## Fixture B: per-drink staff time (unit test)
One day, loaded staff cost $300.00. Sold 100 lattes (prep 90s) and 100 drip coffees (prep 30s).
- Prep-seconds = 100×90 + 100×30 = 12,000 → $0.025 per second
- Latte staff time = **$2.25**, drip = **$0.75**
- Latte at $5.25, ingredients $0.95, effective fee rate 2.9167% → card fee $0.1531 → extra money from one more latte = 5.25 − 0.95 − 0.1531 − 2.25 = **$1.8969 → $1.90**

## Fixture C: menu example for the demo café screen (illustrative, matches mockup)
Latte $5.25: ingredients $0.95, staff time $1.40, card fee $0.15, rent & bills share $0.67 → true profit **$2.08**, extra money from one more latte **$2.75**. Seed prep seconds and recipes so the demo lands within ±$0.05 of these.
