import { randomUUID } from "node:crypto";
import { mulberry32, makeHelpers } from "./rng.mjs";

const DAY_MS = 86_400_000;
const TZ_OFFSET = "-07:00"; // America/Los_Angeles, PDT. Window below never crosses into PST.

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
}

function timeToUtcIso(dateStr, hour, minute) {
  const hh = String(Math.floor(hour)).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${dateStr}T${hh}:${mm}:00${TZ_OFFSET}`;
}

function addMinutesIso(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

// centsPerUnit is tuned (not wholesale-realistic) so the blended ingredient cost lands in the
// "healthy" 25-35% of net sales band from docs/05-calculations.md — see PROGRESS.md decisions.
const INGREDIENTS = [
  { key: "espresso_beans", name: "Espresso beans", base_unit: "g", icon: "beans", centsPerUnit: 2.9 },
  { key: "whole_milk", name: "Whole milk", base_unit: "ml", icon: "milk", centsPerUnit: 0.216 },
  { key: "oat_milk", name: "Oat milk", base_unit: "ml", icon: "milk", centsPerUnit: 0.61 },
  { key: "drip_grounds", name: "Drip coffee grounds", base_unit: "g", icon: "beans", centsPerUnit: 2.0 },
  { key: "cup_12oz", name: "12oz cup", base_unit: "each", icon: "cup", centsPerUnit: 16 },
  { key: "cup_16oz", name: "16oz cup", base_unit: "each", icon: "cup", centsPerUnit: 20 },
  { key: "lid", name: "Lid", base_unit: "each", icon: "cup", centsPerUnit: 5 },
  { key: "vanilla_syrup", name: "Vanilla syrup", base_unit: "ml", icon: "other", centsPerUnit: 2.16 },
  { key: "mocha_sauce", name: "Mocha sauce", base_unit: "ml", icon: "other", centsPerUnit: 2.4 },
  { key: "matcha_powder", name: "Matcha powder", base_unit: "g", icon: "other", centsPerUnit: 5.0 },
  { key: "tea_bag", name: "Tea bag", base_unit: "each", icon: "other", centsPerUnit: 21.6 },
  { key: "croissant", name: "Croissant (wholesale)", base_unit: "each", icon: "other", centsPerUnit: 198 },
  { key: "muffin", name: "Muffin (wholesale)", base_unit: "each", icon: "other", centsPerUnit: 189 },
  { key: "cold_brew_concentrate", name: "Cold brew concentrate", base_unit: "ml", icon: "other", centsPerUnit: 0.81 },
];

/** The one deliberate "milk up" price event the demo tells (see docs/05-calculations.md icon table "Milk"). */
const MILK_INCREASE_DAY_OFFSET = 46;
const MILK_NEW_CENTS_PER_ML = 0.252;

const MENU_ITEMS = [
  { key: "drip", name: "Drip coffee", category: "drink", price_cents: 325, prep_seconds: 30, weight: 20,
    recipe: [["drip_grounds", 18], ["cup_12oz", 1], ["lid", 1]] },
  { key: "cold_brew", name: "Cold brew", category: "drink", price_cents: 425, prep_seconds: 30, weight: 7,
    recipe: [["cold_brew_concentrate", 180], ["cup_16oz", 1], ["lid", 1]] },
  { key: "americano", name: "Americano", category: "drink", price_cents: 375, prep_seconds: 75, weight: 10,
    recipe: [["espresso_beans", 18], ["cup_12oz", 1], ["lid", 1]] },
  { key: "cappuccino", name: "Cappuccino", category: "drink", price_cents: 450, prep_seconds: 90, weight: 12,
    recipe: [["espresso_beans", 18], ["whole_milk", 150], ["cup_12oz", 1], ["lid", 1]] },
  { key: "latte", name: "Latte", category: "drink", price_cents: 525, prep_seconds: 90, weight: 20,
    recipe: [["espresso_beans", 18], ["whole_milk", 295], ["cup_12oz", 1], ["lid", 1]] },
  { key: "vanilla_latte", name: "Vanilla latte", category: "drink", price_cents: 575, prep_seconds: 105, weight: 8,
    recipe: [["espresso_beans", 18], ["whole_milk", 295], ["vanilla_syrup", 22], ["cup_16oz", 1], ["lid", 1]] },
  { key: "mocha", name: "Mocha", category: "drink", price_cents: 575, prep_seconds: 105, weight: 7,
    recipe: [["espresso_beans", 18], ["whole_milk", 265], ["mocha_sauce", 30], ["cup_16oz", 1], ["lid", 1]] },
  { key: "oat_latte", name: "Oat milk latte", category: "drink", price_cents: 575, prep_seconds: 90, weight: 5,
    recipe: [["espresso_beans", 18], ["oat_milk", 295], ["cup_16oz", 1], ["lid", 1]] },
  { key: "matcha_latte", name: "Matcha latte", category: "drink", price_cents: 550, prep_seconds: 120, weight: 4,
    recipe: [["matcha_powder", 4], ["whole_milk", 295], ["cup_16oz", 1], ["lid", 1]] },
  { key: "hot_tea", name: "Hot tea", category: "drink", price_cents: 300, prep_seconds: 45, weight: 3,
    recipe: [["tea_bag", 1], ["cup_12oz", 1], ["lid", 1]] },
  { key: "croissant_item", name: "Croissant", category: "food", price_cents: 375, prep_seconds: 15, weight: 6,
    recipe: [["croissant", 1]] },
  { key: "muffin_item", name: "Muffin", category: "food", price_cents: 350, prep_seconds: 15, weight: 5,
    recipe: [["muffin", 1]] },
];

const EMPLOYEES = [
  { key: "maria", name: "Maria", role: "Shift lead", wage_cents: 2200 },
  { key: "daniel", name: "Daniel", role: "Barista", wage_cents: 1950 },
  { key: "aisha", name: "Aisha", role: "Barista", wage_cents: 1900 },
  { key: "priya", name: "Priya", role: "Barista", wage_cents: 1850 },
  { key: "sam", name: "Sam", role: "Barista", wage_cents: 1800 },
  { key: "jordan", name: "Jordan", role: "Barista", wage_cents: 1900 },
];

const RECURRING = [
  { category_code: "rent", label: "Rent", amount_cents: 320_000, due_day: 1, is_estimate: false },
  { category_code: "utilities_power", label: "Electricity & gas", amount_cents: 78_000, due_day: 5, is_estimate: true },
  { category_code: "water", label: "Water", amount_cents: 18_000, due_day: 10, is_estimate: false },
  { category_code: "internet", label: "Internet & phone", amount_cents: 12_000, due_day: 12, is_estimate: false },
  { category_code: "insurance", label: "Insurance", amount_cents: 26_000, due_day: 15, is_estimate: false },
  { category_code: "loan", label: "Equipment loan", amount_cents: 54_000, due_day: 1, is_estimate: false },
  { category_code: "software", label: "POS & software", amount_cents: 9_500, due_day: 1, is_estimate: false },
  { category_code: "supplies", label: "Napkins, cleaning & store supplies", amount_cents: 65_000, due_day: 20, is_estimate: true },
  // 'repairs' has no recurring row on purpose — see PROGRESS.md decisions (missing-bill alert demo).
];

function ingredientPriceMicros(centsPerUnit) {
  return Math.round(centsPerUnit * 1_000_000);
}

function openHoursFor(weekday) {
  // 0 = Sun ... 6 = Sat. Weekdays open earlier and close later than weekends.
  if (weekday === 0 || weekday === 6) return { openHour: 7, openMinute: 0, closeHour: 16, closeMinute: 0 };
  return { openHour: 6, openMinute: 30, closeHour: 18, closeMinute: 0 };
}

function hourWeightsFor(weekday, openHour, closeHour) {
  const isWeekend = weekday === 0 || weekday === 6;
  const weekdayWeights = { 6: 3, 7: 14, 8: 18, 9: 12, 10: 8, 11: 9, 12: 10, 13: 7, 14: 5, 15: 5, 16: 5, 17: 4 };
  const weekendWeights = { 7: 6, 8: 12, 9: 16, 10: 14, 11: 12, 12: 12, 13: 10, 14: 10, 15: 8 };
  const table = isWeekend ? weekendWeights : weekdayWeights;
  const weights = [];
  for (let h = openHour; h < closeHour; h++) {
    weights.push({ key: h, weight: table[h] ?? 5 });
  }
  return weights;
}

/**
 * Generates 90 days of realistic café activity: orders/lines, timecards, ingredient price
 * history (with one milk price increase), recipes, recurring bills and a handful of
 * receipt/statement expenses. Deterministic (seeded RNG) so `npm run db:reset` always shows
 * the same numbers. Returns plain rows shaped for direct SQL insertion.
 */
export function generateDemoData({ businessId, endDateStr, days = 90 }) {
  const rand = mulberry32(20260926);
  const { weightedKey, int, chance } = makeHelpers(rand);
  const startDateStr = addDays(endDateStr, -(days - 1));

  const locationId = randomUUID();
  const posConnectionId = randomUUID();

  // ---- Ingredients + price history ----
  const ingredientIds = {};
  const ingredients = INGREDIENTS.map((ing) => {
    const id = randomUUID();
    ingredientIds[ing.key] = id;
    return { id, business_id: businessId, name: ing.name, base_unit: ing.base_unit, icon: ing.icon };
  });

  const milkIncreaseDate = addDays(startDateStr, MILK_INCREASE_DAY_OFFSET);
  const ingredientPrices = [];
  for (const ing of INGREDIENTS) {
    ingredientPrices.push({
      id: randomUUID(),
      ingredient_id: ingredientIds[ing.key],
      effective_from: startDateStr,
      cost_per_base_unit_micros: ingredientPriceMicros(ing.centsPerUnit),
      source: "manual",
      source_expense_line_id: null,
    });
  }
  ingredientPrices.push({
    id: randomUUID(),
    ingredient_id: ingredientIds.whole_milk,
    effective_from: milkIncreaseDate,
    cost_per_base_unit_micros: ingredientPriceMicros(MILK_NEW_CENTS_PER_ML),
    source: "receipt",
    source_expense_line_id: null, // linked after the receipt expense is created, below
  });

  function priceMicrosAt(ingredientKey, dateStr) {
    const rows = ingredientPrices.filter((p) => p.ingredient_id === ingredientIds[ingredientKey]);
    const applicable = rows.filter((p) => p.effective_from <= dateStr).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    return applicable[0]?.cost_per_base_unit_micros ?? 0;
  }

  // ---- Menu + recipes ----
  const menuItemIds = {};
  const menuItems = MENU_ITEMS.map((item) => {
    const id = randomUUID();
    menuItemIds[item.key] = id;
    return {
      id,
      business_id: businessId,
      pos_item_id: `DEMO-ITEM-${item.key}`,
      name: item.name,
      price_cents: item.price_cents,
      category: item.category,
      prep_seconds: item.prep_seconds,
      is_active: true,
    };
  });
  const recipeLines = [];
  for (const item of MENU_ITEMS) {
    for (const [ingKey, qty] of item.recipe) {
      recipeLines.push({ menu_item_id: menuItemIds[item.key], ingredient_id: ingredientIds[ingKey], quantity: qty });
    }
  }

  function recipeCostCentsAt(itemKey, dateStr) {
    const item = MENU_ITEMS.find((m) => m.key === itemKey);
    let totalMicros = 0;
    for (const [ingKey, qty] of item.recipe) {
      totalMicros += qty * priceMicrosAt(ingKey, dateStr);
    }
    return totalMicros / 1_000_000; // micro-cents -> cents
  }

  // ---- Employees ----
  const employeeIds = {};
  const employees = EMPLOYEES.map((e) => {
    const id = randomUUID();
    employeeIds[e.key] = id;
    return { id, business_id: businessId, pos_team_member_id: `DEMO-EMP-${e.key}`, display_name: e.name, role: e.role };
  });

  // A handful of specific days get a named scenario. Offsets are from startDateStr.
  const slowDayOffsets = new Set([9, 23, 41, 58, 67, 81]);
  const missedBreakDayOffset = 30;
  const recentVoidSpikeStartOffset = days - 30; // last 30 days run "hot" on voids

  const orders = [];
  const orderLines = [];
  const timecards = [];
  const dailyRollups = [];

  const menuWeights = MENU_ITEMS.map((m) => ({ key: m.key, weight: m.weight }));

  for (let offset = 0; offset < days; offset++) {
    const dateStr = addDays(startDateStr, offset);
    const weekday = weekdayOf(dateStr);
    const { openHour, openMinute, closeHour } = openHoursFor(weekday);
    const isWeekend = weekday === 0 || weekday === 6;
    const isSlowDay = slowDayOffsets.has(offset);

    // ---- Staffing for the day ----
    const openerKey = EMPLOYEES[offset % EMPLOYEES.length].key;
    const closerKey = EMPLOYEES[(offset + 2) % EMPLOYEES.length].key;
    const midKey = EMPLOYEES[(offset + 1) % EMPLOYEES.length].key;
    const rushKey = EMPLOYEES[(offset + 4) % EMPLOYEES.length].key;
    const runsRushShift = !isWeekend && chance(0.7);
    const runsMidShift = chance(0.9);

    let dayWagesCents = 0;
    const openIso = timeToUtcIso(dateStr, openHour, openMinute);

    // Opener: 8h shift starting 15 min before open, with an unpaid 30-min meal break after 5h
    // (skipped once on purpose to demo the "missed meal break" alert).
    const openerClockIn = addMinutesIso(openIso, -15);
    const openerHasBreak = offset !== missedBreakDayOffset;
    const openerBreakStart = addMinutesIso(openerClockIn, 5 * 60);
    const openerBreakEnd = addMinutesIso(openerBreakStart, 30);
    const openerClockOut = addMinutesIso(openerClockIn, 8 * 60 + (openerHasBreak ? 30 : 0));
    const openerPaidHours = (8 * 60) / 60; // 8h paid, break unpaid on top
    timecards.push({
      id: randomUUID(),
      business_id: businessId,
      employee_id: employeeIds[openerKey],
      pos_timecard_id: `DEMO-TC-${dateStr}-opener`,
      clock_in: openerClockIn,
      clock_out: openerClockOut,
      hourly_wage_cents: EMPLOYEES.find((e) => e.key === openerKey).wage_cents,
      breaks: openerHasBreak ? [{ start: openerBreakStart, end: openerBreakEnd, paid: false }] : [],
    });
    dayWagesCents += Math.round(openerPaidHours * EMPLOYEES.find((e) => e.key === openerKey).wage_cents);

    // Closer: starts mid-morning, works to close + 15 min, with a break if the shift runs >5h.
    const closerStartHour = openHour + 3;
    const closerClockIn = timeToUtcIso(dateStr, closerStartHour, openMinute);
    const closeIso = timeToUtcIso(dateStr, closeHour, 0);
    const closerClockOut = addMinutesIso(closeIso, 15);
    const closerShiftMinutes = (new Date(closerClockOut) - new Date(closerClockIn)) / 60_000;
    const closerHasBreak = closerShiftMinutes > 300;
    const closerBreakStart = addMinutesIso(closerClockIn, 5 * 60);
    const closerPaidMinutes = closerHasBreak ? closerShiftMinutes - 30 : closerShiftMinutes;
    timecards.push({
      id: randomUUID(),
      business_id: businessId,
      employee_id: employeeIds[closerKey],
      pos_timecard_id: `DEMO-TC-${dateStr}-closer`,
      clock_in: closerClockIn,
      clock_out: closerClockOut,
      hourly_wage_cents: EMPLOYEES.find((e) => e.key === closerKey).wage_cents,
      breaks: closerHasBreak ? [{ start: closerBreakStart, end: addMinutesIso(closerBreakStart, 30), paid: false }] : [],
    });
    dayWagesCents += Math.round((closerPaidMinutes / 60) * EMPLOYEES.find((e) => e.key === closerKey).wage_cents);

    // Midshift: 6h covering the middle of the day, most days (mirrors a typical 2nd-barista
    // schedule once volume grows past what opener+closer alone can ring up).
    if (runsMidShift) {
      const midClockIn = addMinutesIso(openIso, 90);
      const midShiftMinutes = 6 * 60;
      const midHasBreak = midShiftMinutes > 300;
      const midBreakStart = addMinutesIso(midClockIn, 5 * 60);
      const midClockOut = addMinutesIso(midClockIn, midShiftMinutes + (midHasBreak ? 30 : 0));
      timecards.push({
        id: randomUUID(),
        business_id: businessId,
        employee_id: employeeIds[midKey],
        pos_timecard_id: `DEMO-TC-${dateStr}-mid`,
        clock_in: midClockIn,
        clock_out: midClockOut,
        hourly_wage_cents: EMPLOYEES.find((e) => e.key === midKey).wage_cents,
        breaks: midHasBreak ? [{ start: midBreakStart, end: addMinutesIso(midBreakStart, 30), paid: false }] : [],
      });
      dayWagesCents += Math.round((midShiftMinutes / 60) * EMPLOYEES.find((e) => e.key === midKey).wage_cents);
    }

    // Rush support: short 4h shift covering the morning, most weekdays.
    if (runsRushShift) {
      const rushClockIn = openIso;
      const rushClockOut = addMinutesIso(rushClockIn, 4 * 60);
      timecards.push({
        id: randomUUID(),
        business_id: businessId,
        employee_id: employeeIds[rushKey],
        pos_timecard_id: `DEMO-TC-${dateStr}-rush`,
        clock_in: rushClockIn,
        clock_out: rushClockOut,
        hourly_wage_cents: EMPLOYEES.find((e) => e.key === rushKey).wage_cents,
        breaks: [],
      });
      dayWagesCents += 4 * EMPLOYEES.find((e) => e.key === rushKey).wage_cents;
    }

    // ---- Orders for the day ----
    let baseOrders = isWeekend ? (weekday === 6 ? 520 : 400) : 370;
    if (isSlowDay) baseOrders = Math.round(baseOrders * 0.45);
    const orderCount = Math.max(60, baseOrders + int(-30, 30));

    const hourWeights = hourWeightsFor(weekday, openHour, closeHour);
    const isHotVoidPeriod = offset >= recentVoidSpikeStartOffset;
    const voidRate = isHotVoidPeriod ? 0.045 : 0.01;

    let dayNetSales = 0;
    let dayIngredientsCents = 0;
    let dayDrinksCount = 0;
    let dayCardFees = 0;
    let dayVoidsCents = 0;

    for (let i = 0; i < orderCount; i++) {
      const hour = weightedKey(hourWeights);
      const minute = int(0, 59);
      const closedAt = timeToUtcIso(dateStr, hour, minute);
      const lineCount = chance(0.78) ? 1 : chance(0.85) ? 2 : 3;
      const orderId = randomUUID();
      let orderNet = 0;

      for (let l = 0; l < lineCount; l++) {
        const itemKey = weightedKey(menuWeights);
        const item = MENU_ITEMS.find((m) => m.key === itemKey);
        const voided = chance(voidRate);
        const lineNet = voided ? 0 : item.price_cents;
        orderLines.push({
          id: randomUUID(),
          order_id: orderId,
          menu_item_id: menuItemIds[itemKey],
          pos_item_id: `DEMO-ITEM-${itemKey}`,
          name: item.name,
          quantity: 1,
          net_sales_cents: lineNet,
          modifiers: [],
          voided,
          voided_by: voided ? EMPLOYEES.find((e) => e.key === openerKey).name : null,
        });
        if (voided) {
          dayVoidsCents += item.price_cents;
        } else {
          orderNet += lineNet;
          dayIngredientsCents += recipeCostCentsAt(itemKey, dateStr);
          if (item.category === "drink") dayDrinksCount += 1;
        }
      }

      const taxCents = Math.round(orderNet * 0.0875);
      const tipCents = chance(0.5) ? Math.round(orderNet * 0.12) : 0;
      const feeCents = Math.round(orderNet * 0.029);
      dayCardFees += feeCents;
      dayNetSales += orderNet;

      orders.push({
        id: orderId,
        business_id: businessId,
        location_id: locationId,
        pos_order_id: `DEMO-${dateStr}-${i}`,
        closed_at: closedAt,
        business_date: dateStr,
        gross_sales_cents: orderNet,
        discounts_cents: 0,
        refunds_cents: 0,
        tax_cents: taxCents,
        tip_cents: tipCents,
        processing_fee_cents: feeCents,
        net_sales_cents: orderNet,
        customer_ref: null,
      });
    }

    const staffTaxCents = Math.round(dayWagesCents * 0.12);
    dailyRollups.push({
      business_id: businessId,
      business_date: dateStr,
      net_sales_cents: dayNetSales,
      orders_count: orderCount,
      drinks_count: dayDrinksCount,
      ingredients_cents: Math.round(dayIngredientsCents),
      staff_wages_cents: dayWagesCents,
      staff_tax_cents: staffTaxCents,
      card_fees_cents: dayCardFees,
      voids_cents: Math.round(dayVoidsCents),
    });
  }

  // ---- Recurring bills + actual expenses for each month in the window ----
  const recurringCosts = RECURRING.map((r) => ({
    id: randomUUID(),
    business_id: businessId,
    category_code: r.category_code,
    label: r.label,
    amount_cents: r.amount_cents,
    frequency: "monthly",
    due_day: r.due_day,
    is_estimate: r.is_estimate,
    active_from: startDateStr,
    active_to: null,
  }));

  const currentMonthKey = endDateStr.slice(0, 7);
  const monthKeys = [...new Set(dailyRollups.map((d) => d.business_date.slice(0, 7)))];

  const expenses = [];
  const expenseLines = [];

  for (const monthKey of monthKeys) {
    for (const rc of recurringCosts) {
      // The current month's water bill isn't entered yet — feeds the "missing bill" banner
      // and the "costs entered: N of 9" completeness line (see PROGRESS.md decisions).
      if (monthKey === currentMonthKey && rc.category_code === "water") continue;
      const [y, m] = monthKey.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const dueDay = Math.min(rc.due_day, daysInMonth);
      const spentOn = `${monthKey}-${String(dueDay).padStart(2, "0")}`;
      if (spentOn < startDateStr || spentOn > endDateStr) continue;
      expenses.push({
        id: randomUUID(),
        business_id: businessId,
        spent_on: spentOn,
        amount_cents: rc.amount_cents,
        vendor: rc.label,
        category_code: rc.category_code,
        source: "recurring",
        status: rc.is_estimate && monthKey === currentMonthKey ? "estimated" : "actual",
        recurring_cost_id: rc.id,
        confidence: null,
        reason: null,
        attachment_path: null,
        dedupe_key: `demo-recurring-${rc.category_code}-${spentOn}`,
      });
    }
  }

  // One-off repairs invoice two months back — no recurring row exists for repairs, so this
  // month having nothing is what makes it "missing" rather than just "never tracked".
  const repairsDate = addDays(endDateStr, -58);
  const repairsExpenseId = randomUUID();
  expenses.push({
    id: repairsExpenseId,
    business_id: businessId,
    spent_on: repairsDate,
    amount_cents: 34_000,
    vendor: "Bay Area Espresso Repair",
    category_code: "repairs",
    source: "receipt",
    status: "actual",
    recurring_cost_id: null,
    confidence: 0.92,
    reason: "Matched vendor name Bay Area Espresso Repair",
    attachment_path: null,
    dedupe_key: `demo-repairs-${repairsDate}`,
  });

  // Receipt: a milk/dairy supply run, mapped to the whole_milk ingredient — this is the
  // receipt that justifies the mid-window milk price increase above.
  const milkReceiptDate = milkIncreaseDate;
  const milkReceiptId = randomUUID();
  expenses.push({
    id: milkReceiptId,
    business_id: businessId,
    spent_on: milkReceiptDate,
    amount_cents: 7_920,
    vendor: "Smart & Final",
    category_code: "ingredients",
    source: "receipt",
    status: "actual",
    recurring_cost_id: null,
    confidence: 0.88,
    reason: "Matched vendor name Smart & Final",
    attachment_path: null,
    dedupe_key: `demo-milk-receipt-${milkReceiptDate}`,
  });
  const milkLineId = randomUUID();
  expenseLines.push({
    id: milkLineId,
    expense_id: milkReceiptId,
    description: "SF ORG WHL MILK GAL",
    quantity: 12,
    unit: "gal",
    amount_cents: 7_920,
    ingredient_id: ingredientIds.whole_milk,
  });
  ingredientPrices[ingredientPrices.length - 1].source_expense_line_id = milkLineId;

  // Receipt: cups/lids/napkins restock (stays in "supplies", not mapped to an ingredient).
  const suppliesReceiptDate = addDays(endDateStr, -12);
  const suppliesReceiptId = randomUUID();
  expenses.push({
    id: suppliesReceiptId,
    business_id: businessId,
    spent_on: suppliesReceiptDate,
    amount_cents: 21_400,
    vendor: "Restaurant Depot",
    category_code: "supplies",
    source: "receipt",
    status: "actual",
    recurring_cost_id: null,
    confidence: 0.81,
    reason: "Matched vendor name Restaurant Depot",
    attachment_path: null,
    dedupe_key: `demo-supplies-receipt-${suppliesReceiptDate}`,
  });
  expenseLines.push({
    id: randomUUID(),
    expense_id: suppliesReceiptId,
    description: "12OZ HOT CUP SLEEVE 1000CT",
    quantity: 2,
    unit: "case",
    amount_cents: 14_600,
    ingredient_id: null,
  });
  expenseLines.push({
    id: randomUUID(),
    expense_id: suppliesReceiptId,
    description: "NAPKINS + CLEANING SUPPLIES",
    quantity: 1,
    unit: "order",
    amount_cents: 6_800,
    ingredient_id: null,
  });

  // Two bank-statement lines (simulating an already-imported CSV) for realism in Uploads/Money.
  const statementDate1 = addDays(endDateStr, -20);
  expenses.push({
    id: randomUUID(),
    business_id: businessId,
    spent_on: statementDate1,
    amount_cents: 11_875,
    vendor: "COMCAST BUSINESS",
    category_code: "internet",
    source: "statement",
    status: "actual",
    recurring_cost_id: null,
    confidence: 0.95,
    reason: "Matched vendor name Comcast",
    attachment_path: null,
    dedupe_key: `demo-statement-comcast-${statementDate1}`,
  });
  const statementDate2 = addDays(endDateStr, -6);
  expenses.push({
    id: randomUUID(),
    business_id: businessId,
    spent_on: statementDate2,
    amount_cents: 4_250,
    vendor: "ACME PEST CONTROL",
    category_code: "repairs",
    source: "statement",
    status: "actual",
    recurring_cost_id: null,
    confidence: 0.68,
    reason: "AI categorized: recurring pest-control charge",
    attachment_path: null,
    dedupe_key: `demo-statement-pest-${statementDate2}`,
  });

  const recoveryOrder = [
    "rent", "utilities_power", "water", "internet", "insurance", "loan", "software", "supplies", "repairs", "other",
  ].map((code, i) => ({ business_id: businessId, bucket_code: code, position: i }));

  const business = {
    id: businessId,
    name: "Sunrise Café",
    timezone: "America/Los_Angeles",
    currency: "USD",
    payroll_tax_rate: 0.12,
    default_language: "en",
    opened_on: addDays(startDateStr, -400),
    is_demo: true,
  };

  const location = { id: locationId, business_id: businessId, name: "Main Street", pos_location_id: "DEMO-LOC-1", open_hours: {
    mon: [["06:30", "18:00"]], tue: [["06:30", "18:00"]], wed: [["06:30", "18:00"]], thu: [["06:30", "18:00"]],
    fri: [["06:30", "18:00"]], sat: [["07:00", "16:00"]], sun: [["07:00", "16:00"]],
  } };

  const posConnection = {
    id: posConnectionId,
    business_id: businessId,
    provider: "demo",
    merchant_id: "DEMO-MERCHANT",
    access_token_enc: null,
    refresh_token_enc: null,
    token_expires_at: null,
    status: "active",
    last_synced_at: new Date().toISOString(),
    backfill_completed_at: new Date().toISOString(),
  };

  return {
    business,
    location,
    posConnection,
    ingredients,
    ingredientPrices,
    menuItems,
    recipeLines,
    employees,
    timecards,
    orders,
    orderLines,
    dailyRollups,
    recurringCosts,
    expenses,
    expenseLines,
    recoveryOrder,
    startDateStr,
    endDateStr,
  };
}
