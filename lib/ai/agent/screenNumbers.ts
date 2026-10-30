/** Numbers shown on a screen (AGENTS.md 7.2). Each has one definition in
 * lib/metrics/core, and the chat reads it only through these tools, so the chat
 * always matches the screens. Add an entry only when a screen adds a number. */
export const SCREEN_NUMBERS={
  profit:["get_profit"],
  labor_cost:["get_labor","get_cost_summary","get_profit"],
  card_fees:["get_cost_summary","get_profit"],
  break_even:["get_break_even"],
  item_cost:["get_product_costs","get_price_recommendation"],
} as const satisfies Record<string,readonly string[]>;
export type ScreenNumber=keyof typeof SCREEN_NUMBERS;
export const SCREEN_NUMBER_IDS=Object.keys(SCREEN_NUMBERS) as ScreenNumber[];
