import { createHash } from "node:crypto";
import { mulberry32, makeHelpers } from "./rng.mjs";
import { DEMO_CAFE } from "./cafes.mjs";

const DAY_MS = 86_400_000;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The one deliberate "milk up" price event the demo tells (docs/05-calculations.md icon table "Milk"). */
const MILK_PRICE_INCREASE = 0.252 / 0.216;

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
}

/** Milliseconds the time zone is ahead of UTC at the instant `utcMs`. */
function tzOffsetMs(timeZone, utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A café's local wall-clock time on `dateStr` as a UTC ISO timestamp (handles DST). */
export function localTimeToUtcIso(dateStr, hour, minute, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let utc = wall - tzOffsetMs(timeZone, wall);
  utc = wall - tzOffsetMs(timeZone, utc);
  return new Date(utc).toISOString();
}

function addMinutesIso(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function parseHm(value) {
  const [h, m] = value.split(":").map(Number);
  return { hour: h, minute: m };
}

/** Opening window for a date from the café's `open_hours`, or null when closed. */
function openWindowFor(cafe, weekday) {
  const intervals = cafe.open_hours[DAY_KEYS[weekday]] ?? [];
  if (intervals.length === 0) return null;
  const open = parseHm(intervals[0][0]);
  const close = parseHm(intervals[intervals.length - 1][1]);
  return { openHour: open.hour, openMinute: open.minute, closeHour: close.hour, closeMinute: close.minute };
}

function hourWeightsFor(cafe, isWeekend, openHour, closeHour, closeMinute) {
  const table = isWeekend ? cafe.hourWeights.weekend : cafe.hourWeights.weekday;
  const lastHour = closeMinute > 0 ? closeHour : closeHour - 1;
  const weights = [];
  for (let h = openHour; h <= lastHour; h++) weights.push({ key: h, weight: table[h] ?? 5 });
  return weights;
}

/** Deterministic UUIDs, so the same café profile always produces the same seed file. */
function makeIdFactory(namespace) {
  let n = 0;
  return function nextId() {
    const hex = createHash("sha256").update(`${namespace}:${n++}`).digest("hex");
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

const roundTo = (value, step) => Math.round(value / step) * step;

/**
 * Generates `days` days of realistic café activity for one café profile (see cafes.mjs):
 * orders/lines, timecards, ingredient price history (with one milk price increase), recipes,
 * recurring bills and a handful of receipt/statement expenses. Deterministic (seeded RNG and
 * ids), so the same inputs always give the same rows. Dates and times are the café's own
 * local times; closed days (empty `open_hours`) have no sales and no shifts.
 * Returns plain rows shaped for direct SQL insertion.
 * @param {{ businessId: string, endDateStr: string, days?: number, cafe?: import("./cafes.mjs").CafeProfile }} args
 */
export function generateDemoData({ businessId, endDateStr, days = 90, cafe = DEMO_CAFE }) {
  const rand = mulberry32(cafe.rngSeed);
  const { weightedKey, int, chance } = makeHelpers(rand);
  const nextId = makeIdFactory(`${cafe.key}:${businessId}:${endDateStr}:${days}`);
  const startDateStr = addDays(endDateStr, -(days - 1));
  const tz = cafe.timezone;
  const posPrefix = cafe.key.toUpperCase();
  // Named scenario days, spread over the window the same way for any window length.
  const at = (offsetIn90) => Math.round((offsetIn90 * days) / 90);

  const locationId = nextId();
  const posConnectionId = nextId();

  // ---- Ingredients + price history ----
  const ingredientIds = {};
  const ingredients = cafe.ingredients.map((ing) => {
    const id = nextId();
    ingredientIds[ing.key] = id;
    return { id, business_id: businessId, name: ing.name, base_unit: ing.base_unit, icon: ing.icon };
  });
  const unitCost = (ing) => ing.cost * cafe.costScale;

  const milkIncreaseDate = addDays(startDateStr, at(46));
  const ingredientPrices = cafe.ingredients.map((ing) => ({
    id: nextId(),
    ingredient_id: ingredientIds[ing.key],
    effective_from: startDateStr,
    cost_per_base_unit_micros: Math.round(unitCost(ing) * 1_000_000),
    source: "manual",
    source_expense_line_id: null,
  }));
  const milk = cafe.ingredients.find((i) => i.key === "whole_milk");
  const milkIncrease = {
    id: nextId(),
    ingredient_id: ingredientIds.whole_milk,
    effective_from: milkIncreaseDate,
    cost_per_base_unit_micros: Math.round(unitCost(milk) * MILK_PRICE_INCREASE * 1_000_000),
    source: "receipt",
    source_expense_line_id: null, // linked after the receipt expense is created, below
  };
  ingredientPrices.push(milkIncrease);

  function priceMicrosAt(ingredientKey, dateStr) {
    const applicable = ingredientPrices
      .filter((p) => p.ingredient_id === ingredientIds[ingredientKey] && p.effective_from <= dateStr)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
    return applicable[0]?.cost_per_base_unit_micros ?? 0;
  }

  // ---- Menu + recipes ----
  const menuItemIds = {};
  const menuPrice = {};
  const menuItems = cafe.menu.map((item) => {
    const id = nextId();
    menuItemIds[item.key] = id;
    menuPrice[item.key] = roundTo(item.price * cafe.priceScale, 5);
    return {
      id,
      business_id: businessId,
      pos_item_id: `${posPrefix}-ITEM-${item.key}`,
      name: item.name,
      base_name: item.name,
      price_cents: menuPrice[item.key],
      category: item.category,
      prep_seconds: item.prep_seconds,
      is_active: true,
    };
  });
  const recipeLines = [];
  for (const item of cafe.menu) {
    for (const [ingKey, qty] of item.recipe) {
      recipeLines.push({ menu_item_id: menuItemIds[item.key], ingredient_id: ingredientIds[ingKey], quantity: qty });
    }
  }

  function recipeCostCentsAt(itemKey, dateStr) {
    const item = cafe.menu.find((m) => m.key === itemKey);
    let totalMicros = 0;
    for (const [ingKey, qty] of item.recipe) totalMicros += qty * priceMicrosAt(ingKey, dateStr);
    return totalMicros / 1_000_000; // micro-cents -> cents
  }

  // ---- Employees ----
  const staff = cafe.employees.map((e) => ({ ...e, wage_cents: Math.round(e.wage * cafe.wageScale) }));
  const employeeIds = {};
  const employees = staff.map((e) => {
    const id = nextId();
    employeeIds[e.key] = id;
    return { id, business_id: businessId, pos_team_member_id: `${posPrefix}-EMP-${e.key}`, display_name: e.name, role: e.role };
  });
  const wageOf = (key) => staff.find((e) => e.key === key).wage_cents;

  const slowDayOffsets = new Set([9, 23, 41, 58, 67, 81].map(at));
  const missedBreakDayOffset = at(30);
  const recentVoidSpikeStartOffset = days - Math.round(days / 3); // last third runs "hot" on voids

  const orders = [];
  const orderLines = [];
  const timecards = [];
  const dailyRollups = [];
  const processingFeeDailyFacts = [];
  const menuWeights = cafe.menu.map((m) => ({ key: m.key, weight: m.weight }));

  for (let offset = 0; offset < days; offset++) {
    const dateStr = addDays(startDateStr, offset);
    const weekday = weekdayOf(dateStr);
    const window = openWindowFor(cafe, weekday);
    if (!window) continue; // closed: no shifts, no sales, no daily row
    const { openHour, openMinute, closeHour, closeMinute } = window;
    const isWeekend = weekday === 0 || weekday === 6;
    const isSlowDay = slowDayOffsets.has(offset);

    const openIso = localTimeToUtcIso(dateStr, openHour, openMinute, tz);
    const closeIso = localTimeToUtcIso(dateStr, closeHour, closeMinute, tz);
    const openMinutes = (new Date(closeIso) - new Date(openIso)) / 60_000;

    // ---- Staffing for the day ----
    const openerKey = staff[offset % staff.length].key;
    const closerKey = staff[(offset + 2) % staff.length].key;
    const midKey = staff[(offset + 1) % staff.length].key;
    const rushKey = staff[(offset + 4) % staff.length].key;
    const runsRushShift = !isWeekend && chance(0.7);
    const runsMidShift = chance(0.9) && openMinutes >= 7.5 * 60;
    const runsCloserShift = openMinutes > 8 * 60;

    let dayWagesCents = 0;
    function addShift(role, employeeKey, clockIn, paidMinutes, breaks) {
      const breakMinutes = breaks.reduce((s, b) => s + (new Date(b.end) - new Date(b.start)) / 60_000, 0);
      timecards.push({
        id: nextId(),
        business_id: businessId,
        employee_id: employeeIds[employeeKey],
        pos_timecard_id: `${posPrefix}-TC-${dateStr}-${role}`,
        clock_in: clockIn,
        clock_out: addMinutesIso(clockIn, paidMinutes + breakMinutes),
        hourly_wage_cents: wageOf(employeeKey),
        breaks,
      });
      dayWagesCents += Math.round((paidMinutes / 60) * wageOf(employeeKey));
    }
    const mealBreak = (clockIn) => {
      const start = addMinutesIso(clockIn, 5 * 60);
      return [{ start, end: addMinutesIso(start, 30), paid: false }];
    };

    // Opener: up to 8h paid from 15 min before open, unpaid 30-min meal break after 5h
    // (skipped once on purpose to demo the "missed meal break" alert).
    const openerClockIn = addMinutesIso(openIso, -15);
    const openerPaid = Math.min(8 * 60, openMinutes + 30);
    const openerHasBreak = offset !== missedBreakDayOffset && openerPaid > 5 * 60;
    addShift("opener", openerKey, openerClockIn, openerPaid, openerHasBreak ? mealBreak(openerClockIn) : []);

    // Closer: starts 3h after open, works to close + 15 min, break if the shift runs >5h.
    if (runsCloserShift) {
      const closerClockIn = addMinutesIso(openIso, 3 * 60);
      const closerShiftMinutes = (new Date(addMinutesIso(closeIso, 15)) - new Date(closerClockIn)) / 60_000;
      const closerHasBreak = closerShiftMinutes > 300;
      addShift("closer", closerKey, closerClockIn, closerHasBreak ? closerShiftMinutes - 30 : closerShiftMinutes,
        closerHasBreak ? mealBreak(closerClockIn) : []);
    }

    // Midshift: 6h covering the middle of the day, most days.
    if (runsMidShift) {
      const midClockIn = addMinutesIso(openIso, 90);
      addShift("mid", midKey, midClockIn, 6 * 60, mealBreak(midClockIn));
    }

    // Rush support: short 4h shift covering the morning, most weekdays.
    if (runsRushShift) addShift("rush", rushKey, openIso, 4 * 60, []);

    // ---- Orders for the day ----
    let baseOrders = weekday === 6 ? cafe.ordersPerDay.sat : weekday === 0 ? cafe.ordersPerDay.sun : cafe.ordersPerDay.weekday;
    if (isSlowDay) baseOrders = Math.round(baseOrders * 0.45);
    const orderCount = Math.max(1, baseOrders + int(-30, 30));

    const hourWeights = hourWeightsFor(cafe, isWeekend, openHour, closeHour, closeMinute);
    const voidRate = offset >= recentVoidSpikeStartOffset ? 0.045 : 0.01;

    let dayNetSales = 0;
    let dayIngredientsCents = 0;
    let dayDrinksCount = 0;
    let dayCardFees = 0;
    let dayVoidsCents = 0;

    for (let i = 0; i < orderCount; i++) {
      const hour = weightedKey(hourWeights);
      let minute = int(0, 59);
      // Keep every order inside the opening window.
      if (hour === openHour && minute < openMinute) minute = openMinute + (minute % (60 - openMinute));
      if (hour === closeHour && minute >= closeMinute) minute = minute % closeMinute;
      const closedAt = localTimeToUtcIso(dateStr, hour, minute, tz);
      const lineCount = chance(0.78) ? 1 : chance(0.85) ? 2 : 3;
      const orderId = nextId();
      let orderNet = 0;

      for (let l = 0; l < lineCount; l++) {
        const itemKey = weightedKey(menuWeights);
        const item = cafe.menu.find((m) => m.key === itemKey);
        const voided = chance(voidRate);
        const lineNet = voided ? 0 : menuPrice[itemKey];
        orderLines.push({
          id: nextId(),
          order_id: orderId,
          menu_item_id: menuItemIds[itemKey],
          pos_item_id: `${posPrefix}-ITEM-${itemKey}`,
          name: item.name,
          quantity: 1,
          net_sales_cents: lineNet,
          modifiers: [],
          voided,
          voided_by: voided ? staff.find((e) => e.key === openerKey).name : null,
        });
        if (voided) {
          dayVoidsCents += menuPrice[itemKey];
        } else {
          orderNet += lineNet;
          dayIngredientsCents += recipeCostCentsAt(itemKey, dateStr);
          if (item.category === "drink") dayDrinksCount += 1;
        }
      }

      const taxCents = Math.round(orderNet * cafe.salesTaxRate);
      const tipCents = chance(cafe.tipChance) ? Math.round(orderNet * cafe.tipRate) : 0;
      const feeCents = Math.round(orderNet * cafe.cardFeeRate);
      dayCardFees += feeCents;
      dayNetSales += orderNet;

      orders.push({
        id: orderId,
        business_id: businessId,
        location_id: locationId,
        pos_order_id: `${posPrefix}-${dateStr}-${i}`,
        closed_at: closedAt,
        business_date: dateStr,
        gross_sales_cents: orderNet,
        discounts_cents: 0,
        refunds_cents: 0,
        tax_cents: taxCents,
        tip_cents: tipCents,
        processing_fee_cents: feeCents,
        processing_fee_status: "actual",
        processing_fee_provider: "demo",
        net_sales_cents: orderNet,
        customer_ref: null,
      });
    }

    dailyRollups.push({
      business_id: businessId,
      business_date: dateStr,
      net_sales_cents: dayNetSales,
      orders_count: orderCount,
      drinks_count: dayDrinksCount,
      ingredients_cents: Math.round(dayIngredientsCents),
      staff_wages_cents: dayWagesCents,
      staff_tax_cents: Math.round(dayWagesCents * cafe.payrollTaxRate),
      card_fees_cents: dayCardFees,
      card_fees_status: "actual",
      voids_cents: Math.round(dayVoidsCents),
      // Every order and void of the day is generated, so the day's sales and voids are complete.
      sales_data_status: "actual",
      voids_status: "complete",
    });
    processingFeeDailyFacts.push({
      business_id: businessId,
      business_date: dateStr,
      amount_cents: dayCardFees,
      status: "actual",
      source_type: "connected_pos_actual",
      provider: "demo",
      source_reference: `demo:${dateStr}`,
      metadata: {},
    });
  }

  // ---- Recurring bills + actual expenses for each month in the window ----
  const billAmount = (amount) => roundTo(amount * cafe.costScale, 100);
  const recurringCosts = cafe.recurring.map((r) => ({
    id: nextId(),
    business_id: businessId,
    category_code: r.category_code,
    label: r.label,
    amount_cents: billAmount(r.amount),
    frequency: "monthly",
    due_day: r.due_day,
    is_estimate: r.is_estimate,
    active_from: startDateStr,
    active_to: null,
  }));

  const currentMonthKey = endDateStr.slice(0, 7);
  const monthKeys = [];
  for (let offset = 0; offset < days; offset++) {
    const key = addDays(startDateStr, offset).slice(0, 7);
    if (!monthKeys.includes(key)) monthKeys.push(key);
  }

  const expenses = [];
  const expenseLines = [];
  const scaled = (amount) => Math.round(amount * cafe.costScale);
  const v = cafe.vendors;

  for (const monthKey of monthKeys) {
    for (const rc of recurringCosts) {
      // The current month's water bill isn't entered yet — feeds the "missing bill" banner
      // and the "costs entered: N of 9" completeness line.
      if (monthKey === currentMonthKey && rc.category_code === "water") continue;
      const [y, m] = monthKey.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const spentOn = `${monthKey}-${String(Math.min(rc.due_day, daysInMonth)).padStart(2, "0")}`;
      if (spentOn < startDateStr || spentOn > endDateStr) continue;
      expenses.push({
        id: nextId(),
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

  function oneOffExpense(spentOn, amount, vendor, category, source, confidence, reason, dedupe) {
    const id = nextId();
    expenses.push({
      id, business_id: businessId, spent_on: spentOn, amount_cents: amount, vendor, category_code: category,
      source, status: "actual", recurring_cost_id: null, confidence, reason, attachment_path: null, dedupe_key: dedupe,
    });
    return id;
  }

  // One-off repairs invoice — no recurring row exists for repairs, so a month having nothing
  // is what makes it "missing" rather than just "never tracked".
  const repairsDate = addDays(endDateStr, -at(58));
  oneOffExpense(repairsDate, scaled(34_000), v.repairs, "repairs", "receipt", 0.92,
    `Matched vendor name ${v.repairs}`, `demo-repairs-${repairsDate}`);

  // Receipt: a milk supply run mapped to the whole_milk ingredient — the receipt that
  // justifies the mid-window milk price increase above.
  const milkAmount = scaled(7_920);
  const milkReceiptId = oneOffExpense(milkIncreaseDate, milkAmount, v.milk, "ingredients", "receipt", 0.88,
    `Matched vendor name ${v.milk}`, `demo-milk-receipt-${milkIncreaseDate}`);
  const milkLineId = nextId();
  expenseLines.push({
    id: milkLineId, expense_id: milkReceiptId, description: v.milkLine, quantity: 12, unit: v.milkUnit,
    amount_cents: milkAmount, ingredient_id: ingredientIds.whole_milk,
  });
  milkIncrease.source_expense_line_id = milkLineId;

  // Receipt: cups/lids/napkins restock (stays in "supplies", not mapped to an ingredient).
  const suppliesDate = addDays(endDateStr, -at(12));
  const cupsAmount = scaled(14_600);
  const napkinsAmount = scaled(6_800);
  const suppliesId = oneOffExpense(suppliesDate, cupsAmount + napkinsAmount, v.supplies, "supplies", "receipt", 0.81,
    `Matched vendor name ${v.supplies}`, `demo-supplies-receipt-${suppliesDate}`);
  expenseLines.push(
    { id: nextId(), expense_id: suppliesId, description: "12OZ HOT CUP SLEEVE 1000CT", quantity: 2, unit: "case",
      amount_cents: cupsAmount, ingredient_id: null },
    { id: nextId(), expense_id: suppliesId, description: "NAPKINS + CLEANING SUPPLIES", quantity: 1, unit: "order",
      amount_cents: napkinsAmount, ingredient_id: null },
  );

  // Two bank-statement lines (simulating an already-imported CSV) for realism in Uploads/Money.
  const statementDate1 = addDays(endDateStr, -at(20));
  oneOffExpense(statementDate1, scaled(11_875), v.internetStatement, "internet", "statement", 0.95,
    `Matched vendor name ${v.internetStatement}`, `demo-statement-internet-${statementDate1}`);
  const statementDate2 = addDays(endDateStr, -at(6));
  oneOffExpense(statementDate2, scaled(4_250), v.pestStatement, "repairs", "statement", 0.68,
    "AI categorized: recurring pest-control charge", `demo-statement-pest-${statementDate2}`);

  const recoveryOrder = [
    "rent", "utilities_power", "water", "internet", "insurance", "loan", "software", "supplies", "repairs", "other",
  ].map((code, i) => ({ business_id: businessId, bucket_code: code, position: i }));

  const business = {
    id: businessId,
    name: cafe.name,
    timezone: cafe.timezone,
    currency: cafe.currency,
    payroll_tax_rate: cafe.payrollTaxRate,
    default_language: cafe.defaultLanguage,
    opened_on: addDays(startDateStr, -400),
    is_demo: cafe.isDemo,
  };

  const location = {
    id: locationId, business_id: businessId, name: cafe.locationName, pos_location_id: `${posPrefix}-LOC-1`,
    open_hours: cafe.open_hours,
  };

  // "Last synced" = the last order in the window, so nothing depends on the clock at generation.
  const lastOrderAt = orders.reduce((max, o) => (o.closed_at > max ? o.closed_at : max), localTimeToUtcIso(endDateStr, 0, 0, tz));
  const posConnection = {
    id: posConnectionId,
    business_id: businessId,
    provider: "demo",
    merchant_id: `${posPrefix}-MERCHANT`,
    access_token_enc: null,
    refresh_token_enc: null,
    token_expires_at: null,
    status: "active",
    last_synced_at: lastOrderAt,
    backfill_completed_at: lastOrderAt,
  };

  const processingFeeDailyCandidates = processingFeeDailyFacts.map((fact) => ({ ...fact, eligible: true }));

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
    processingFeeDailyCandidates,
    processingFeeDailyFacts,
    recurringCosts,
    expenses,
    expenseLines,
    recoveryOrder,
    startDateStr,
    endDateStr,
  };
}
