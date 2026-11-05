/**
 * Café profiles for generated seed data. Everything that differs between cafés lives here
 * (currency, time zone, opening hours, prices, tax and fee rates, owner login), so the
 * generator in demoData.mjs never assumes one café, currency or time zone.
 *
 * Money is integer minor units (cents) of the profile's own currency.
 * `open_hours` uses the app's format (lib/business/openHours.ts): day key -> [[open, close]],
 * an empty list means closed that day.
 */

/**
 * @typedef {Record<number, number>} HourWeights  local hour -> share of the day's orders
 * @typedef {{ userId: string, email: string, password: string }} OwnerLogin
 * @typedef {{
 *   key: string, rngSeed: number, businessId?: string, name: string, locationName: string,
 *   timezone: string, currency: string, defaultLanguage: string, isDemo: boolean,
 *   payrollTaxRate: number, salesTaxRate: number, cardFeeRate: number, tipChance: number, tipRate: number,
 *   priceScale: number, costScale: number, wageScale: number,
 *   ordersPerDay: { weekday: number, sat: number, sun: number },
 *   hourWeights: { weekday: HourWeights, weekend: HourWeights },
 *   open_hours: Record<string, [string, string][]>,
 *   vendors: Record<string, string>,
 *   menu: { key: string, name: string, category: string, price: number, prep_seconds: number, weight: number, recipe: [string, number][] }[],
 *   ingredients: { key: string, name: string, base_unit: string, icon: string, cost: number }[],
 *   employees: { key: string, name: string, role: string, wage: number }[],
 *   recurring: { category_code: string, label: string, amount: number, due_day: number, is_estimate: boolean }[],
 *   owner: OwnerLogin | null,
 * }} CafeProfile
 */

const SHARED_MENU = [
  // key, name, category, base price (minor units), prep seconds, popularity weight, recipe
  { key: "drip", name: "Drip coffee", category: "drink", price: 325, prep_seconds: 30, weight: 20,
    recipe: [["drip_grounds", 18], ["cup_12oz", 1], ["lid", 1]] },
  { key: "cold_brew", name: "Cold brew", category: "drink", price: 425, prep_seconds: 30, weight: 7,
    recipe: [["cold_brew_concentrate", 180], ["cup_16oz", 1], ["lid", 1]] },
  { key: "americano", name: "Americano", category: "drink", price: 375, prep_seconds: 75, weight: 10,
    recipe: [["espresso_beans", 18], ["cup_12oz", 1], ["lid", 1]] },
  { key: "cappuccino", name: "Cappuccino", category: "drink", price: 450, prep_seconds: 90, weight: 12,
    recipe: [["espresso_beans", 18], ["whole_milk", 150], ["cup_12oz", 1], ["lid", 1]] },
  { key: "latte", name: "Latte", category: "drink", price: 525, prep_seconds: 90, weight: 20,
    recipe: [["espresso_beans", 18], ["whole_milk", 295], ["cup_12oz", 1], ["lid", 1]] },
  { key: "vanilla_latte", name: "Vanilla latte", category: "drink", price: 575, prep_seconds: 105, weight: 8,
    recipe: [["espresso_beans", 18], ["whole_milk", 295], ["vanilla_syrup", 22], ["cup_16oz", 1], ["lid", 1]] },
  { key: "mocha", name: "Mocha", category: "drink", price: 575, prep_seconds: 105, weight: 7,
    recipe: [["espresso_beans", 18], ["whole_milk", 265], ["mocha_sauce", 30], ["cup_16oz", 1], ["lid", 1]] },
  { key: "oat_latte", name: "Oat milk latte", category: "drink", price: 575, prep_seconds: 90, weight: 5,
    recipe: [["espresso_beans", 18], ["oat_milk", 295], ["cup_16oz", 1], ["lid", 1]] },
  { key: "matcha_latte", name: "Matcha latte", category: "drink", price: 550, prep_seconds: 120, weight: 4,
    recipe: [["matcha_powder", 4], ["whole_milk", 295], ["cup_16oz", 1], ["lid", 1]] },
  { key: "hot_tea", name: "Hot tea", category: "drink", price: 300, prep_seconds: 45, weight: 3,
    recipe: [["tea_bag", 1], ["cup_12oz", 1], ["lid", 1]] },
  { key: "croissant_item", name: "Croissant", category: "food", price: 375, prep_seconds: 15, weight: 6,
    recipe: [["croissant", 1]] },
  { key: "muffin_item", name: "Muffin", category: "food", price: 350, prep_seconds: 15, weight: 5,
    recipe: [["muffin", 1]] },
];

// Unit costs are tuned (not wholesale-realistic) so the blended ingredient cost lands in the
// "healthy" 25-35% of net sales band from docs/05-calculations.md.
const SHARED_INGREDIENTS = [
  { key: "espresso_beans", name: "Espresso beans", base_unit: "g", icon: "beans", cost: 2.9 },
  { key: "whole_milk", name: "Whole milk", base_unit: "ml", icon: "milk", cost: 0.216 },
  { key: "oat_milk", name: "Oat milk", base_unit: "ml", icon: "milk", cost: 0.61 },
  { key: "drip_grounds", name: "Drip coffee grounds", base_unit: "g", icon: "beans", cost: 2.0 },
  { key: "cup_12oz", name: "12oz cup", base_unit: "each", icon: "cup", cost: 16 },
  { key: "cup_16oz", name: "16oz cup", base_unit: "each", icon: "cup", cost: 20 },
  { key: "lid", name: "Lid", base_unit: "each", icon: "cup", cost: 5 },
  { key: "vanilla_syrup", name: "Vanilla syrup", base_unit: "ml", icon: "other", cost: 2.16 },
  { key: "mocha_sauce", name: "Mocha sauce", base_unit: "ml", icon: "other", cost: 2.4 },
  { key: "matcha_powder", name: "Matcha powder", base_unit: "g", icon: "other", cost: 5.0 },
  { key: "tea_bag", name: "Tea bag", base_unit: "each", icon: "other", cost: 21.6 },
  { key: "croissant", name: "Croissant (wholesale)", base_unit: "each", icon: "other", cost: 198 },
  { key: "muffin", name: "Muffin (wholesale)", base_unit: "each", icon: "other", cost: 189 },
  { key: "cold_brew_concentrate", name: "Cold brew concentrate", base_unit: "ml", icon: "other", cost: 0.81 },
];

const SHARED_EMPLOYEES = [
  { key: "maria", name: "Maria", role: "Shift lead", wage: 2200 },
  { key: "daniel", name: "Daniel", role: "Barista", wage: 1950 },
  { key: "aisha", name: "Aisha", role: "Barista", wage: 1900 },
  { key: "priya", name: "Priya", role: "Barista", wage: 1850 },
  { key: "sam", name: "Sam", role: "Barista", wage: 1800 },
  { key: "jordan", name: "Jordan", role: "Barista", wage: 1900 },
];

// 'repairs' has no recurring row on purpose (missing-bill alert demo).
const SHARED_RECURRING = [
  { category_code: "rent", label: "Rent", amount: 320_000, due_day: 1, is_estimate: false },
  { category_code: "utilities_power", label: "Electricity & gas", amount: 78_000, due_day: 5, is_estimate: true },
  { category_code: "water", label: "Water", amount: 18_000, due_day: 10, is_estimate: false },
  { category_code: "internet", label: "Internet & phone", amount: 12_000, due_day: 12, is_estimate: false },
  { category_code: "insurance", label: "Insurance", amount: 26_000, due_day: 15, is_estimate: false },
  { category_code: "loan", label: "Equipment loan", amount: 54_000, due_day: 1, is_estimate: false },
  { category_code: "software", label: "POS & software", amount: 9_500, due_day: 1, is_estimate: false },
  { category_code: "supplies", label: "Napkins, cleaning & store supplies", amount: 65_000, due_day: 20, is_estimate: true },
];

const WEEKDAY_HOUR_WEIGHTS = { 6: 3, 7: 14, 8: 18, 9: 12, 10: 8, 11: 9, 12: 10, 13: 7, 14: 5, 15: 5, 16: 5, 17: 4 };
const WEEKEND_HOUR_WEIGHTS = { 7: 6, 8: 12, 9: 16, 10: 14, 11: 12, 12: 12, 13: 10, 14: 10, 15: 8 };

/**
 * The shared demo café that `npm run db:reset` loads into a remote project.
 * @type {CafeProfile}
 */
export const DEMO_CAFE = {
  key: "demo",
  rngSeed: 20260926,
  name: "Sunrise Café",
  locationName: "Main Street",
  timezone: "America/Los_Angeles",
  currency: "USD",
  defaultLanguage: "en",
  isDemo: true,
  payrollTaxRate: 0.12,
  salesTaxRate: 0.0875,
  cardFeeRate: 0.029,
  tipChance: 0.5,
  tipRate: 0.12,
  priceScale: 1,
  costScale: 1,
  wageScale: 1,
  ordersPerDay: { weekday: 370, sat: 520, sun: 400 },
  hourWeights: { weekday: WEEKDAY_HOUR_WEIGHTS, weekend: WEEKEND_HOUR_WEIGHTS },
  open_hours: {
    mon: [["06:30", "18:00"]], tue: [["06:30", "18:00"]], wed: [["06:30", "18:00"]], thu: [["06:30", "18:00"]],
    fri: [["06:30", "18:00"]], sat: [["07:00", "16:00"]], sun: [["07:00", "16:00"]],
  },
  vendors: {
    repairs: "Bay Area Espresso Repair",
    milk: "Smart & Final",
    milkLine: "SF ORG WHL MILK GAL",
    milkUnit: "gal",
    supplies: "Restaurant Depot",
    internetStatement: "COMCAST BUSINESS",
    pestStatement: "ACME PEST CONTROL",
  },
  menu: SHARED_MENU,
  ingredients: SHARED_INGREDIENTS,
  employees: SHARED_EMPLOYEES,
  recurring: SHARED_RECURRING,
  // The demo café's login is created by scripts/db-reset.mjs, not by the seed file.
  owner: null,
};

/**
 * The two local test cafés in supabase/seed.sql. They differ on purpose in currency, time
 * zone, opening hours (one is closed on Sunday), prices, taxes and fees, so tests catch any
 * code that assumes one café's settings. Owner passwords are for the local stack only.
 * @type {(CafeProfile & { businessId: string, owner: OwnerLogin })[]}
 */
export const TEST_CAFES = [
  {
    key: "test-usd",
    rngSeed: 41001,
    businessId: "a1000000-0000-4000-8000-000000000001",
    name: "Harbor Test Café",
    locationName: "Harbor Street",
    timezone: "America/New_York",
    currency: "USD",
    defaultLanguage: "en",
    isDemo: false,
    payrollTaxRate: 0.1,
    salesTaxRate: 0.08875,
    cardFeeRate: 0.029,
    tipChance: 0.55,
    tipRate: 0.15,
    priceScale: 1.1,
    costScale: 1.05,
    wageScale: 1.1,
    ordersPerDay: { weekday: 240, sat: 300, sun: 260 },
    hourWeights: { weekday: WEEKDAY_HOUR_WEIGHTS, weekend: WEEKEND_HOUR_WEIGHTS },
    open_hours: {
      mon: [["06:00", "17:00"]], tue: [["06:00", "17:00"]], wed: [["06:00", "17:00"]], thu: [["06:00", "17:00"]],
      fri: [["06:00", "17:00"]], sat: [["07:00", "15:00"]], sun: [["08:00", "14:00"]],
    },
    vendors: {
      repairs: "Harbor Espresso Service",
      milk: "Hudson Dairy Supply",
      milkLine: "WHOLE MILK GAL",
      milkUnit: "gal",
      supplies: "Restaurant Depot",
      internetStatement: "VERIZON BUSINESS",
      pestStatement: "HARBOR PEST CONTROL",
    },
    menu: SHARED_MENU,
    ingredients: SHARED_INGREDIENTS,
    employees: SHARED_EMPLOYEES,
    recurring: SHARED_RECURRING,
    owner: { userId: "a1000000-0000-4000-8000-0000000000aa", email: "owner.usd@example.com", password: "local-test-usd" },
  },
  {
    key: "test-eur",
    rngSeed: 42002,
    businessId: "b2000000-0000-4000-8000-000000000002",
    name: "Plaza Test Café",
    locationName: "Plaza Mayor",
    timezone: "Europe/Madrid",
    currency: "EUR",
    defaultLanguage: "en",
    isDemo: false,
    payrollTaxRate: 0.3,
    salesTaxRate: 0.1,
    cardFeeRate: 0.012,
    tipChance: 0.15,
    tipRate: 0.05,
    priceScale: 0.62,
    costScale: 0.85,
    wageScale: 0.7,
    ordersPerDay: { weekday: 160, sat: 220, sun: 0 },
    hourWeights: {
      weekday: { 8: 12, 9: 16, 10: 12, 11: 10, 12: 8, 13: 6, 14: 5, 15: 6, 16: 9, 17: 10, 18: 7, 19: 4 },
      weekend: { 9: 10, 10: 16, 11: 18, 12: 14, 13: 8 },
    },
    open_hours: {
      mon: [["08:00", "20:00"]], tue: [["08:00", "20:00"]], wed: [["08:00", "20:00"]], thu: [["08:00", "20:00"]],
      fri: [["08:00", "20:00"]], sat: [["09:00", "14:00"]], sun: [],
    },
    vendors: {
      repairs: "Servicio Técnico Cafetero",
      milk: "Makro",
      milkLine: "LECHE ENTERA 1L",
      milkUnit: "l",
      supplies: "Makro",
      internetStatement: "MOVISTAR EMPRESAS",
      pestStatement: "PLAGAS CONTROL SL",
    },
    menu: SHARED_MENU,
    ingredients: SHARED_INGREDIENTS,
    employees: SHARED_EMPLOYEES,
    recurring: SHARED_RECURRING,
    owner: { userId: "b2000000-0000-4000-8000-0000000000bb", email: "owner.eur@example.com", password: "local-test-eur" },
  },
];
