import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_CAFES } from "./cafes.mjs";
import { generateDemoData, localTimeToUtcIso } from "./demoData.mjs";
import { buildSeedSql, latestClosedDate, SEED_HEADER_RE } from "./seedSql.mjs";

const seedPath = path.resolve(import.meta.dirname, "..", "..", "supabase", "seed.sql");
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function localParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

describe("supabase/seed.sql", () => {
  it("is exactly the generator's output for the window in its header", () => {
    const committed = readFileSync(seedPath, "utf8");
    const match = committed.match(SEED_HEADER_RE);
    expect(match).not.toBeNull();
    const regenerated = buildSeedSql({ cafes: TEST_CAFES, endDateStr: match![1], days: Number(match![2]) });
    expect(committed === regenerated).toBe(true);
  });

  it("loads each test café with its own currency, time zone and owner", () => {
    const committed = readFileSync(seedPath, "utf8");
    for (const cafe of TEST_CAFES) {
      expect(committed).toContain(`('${cafe.businessId}','${cafe.name}','${cafe.timezone}','${cafe.currency}',`);
      expect(committed).toContain(`'${cafe.owner!.email}'`);
      expect(committed).toContain(`values ('${cafe.businessId}', '${cafe.owner!.userId}', 'owner', true);`);
    }
  });
});

describe("test café profiles", () => {
  it("differ in currency, time zone and opening hours", () => {
    expect(TEST_CAFES).toHaveLength(2);
    const [a, b] = TEST_CAFES;
    expect(a.currency).not.toBe(b.currency);
    expect(a.timezone).not.toBe(b.timezone);
    expect(JSON.stringify(a.open_hours)).not.toBe(JSON.stringify(b.open_hours));
    expect(new Set(TEST_CAFES.map((c) => c.businessId)).size).toBe(2);
    expect(new Set(TEST_CAFES.map((c) => c.owner!.email)).size).toBe(2);
  });
});

describe("generateDemoData", () => {
  const endDateStr = "2026-11-03"; // window crosses the Nov 1 US daylight-saving change

  for (const cafe of TEST_CAFES) {
    describe(cafe.name, () => {
      const data = generateDemoData({ businessId: cafe.businessId, endDateStr, days: 14, cafe });

      it("takes currency, time zone and hours from the profile", () => {
        expect(data.business).toMatchObject({ id: cafe.businessId, currency: cafe.currency, timezone: cafe.timezone, is_demo: false });
        expect(data.location.open_hours).toEqual(cafe.open_hours);
      });

      it("puts every order inside that day's local opening hours, on its local business date", () => {
        expect(data.orders.length).toBeGreaterThan(0);
        for (const order of data.orders) {
          const local = localParts(order.closed_at, cafe.timezone);
          expect(local.date).toBe(order.business_date);
          const weekday = new Date(`${order.business_date}T00:00:00Z`).getUTCDay();
          const [[open, close]] = cafe.open_hours[DAY_KEYS[weekday]] as [string, string][];
          expect(local.time >= open && local.time < close).toBe(true);
        }
      });

      it("has no sales or shifts on closed days, and a daily row for every open day", () => {
        const closedDates = new Set<string>();
        const openDates = new Set<string>();
        for (let i = 0; i < 14; i++) {
          const d = new Date(Date.parse(`${data.startDateStr}T00:00:00Z`) + i * 86_400_000);
          const key = DAY_KEYS[d.getUTCDay()];
          ((cafe.open_hours[key] ?? []).length === 0 ? closedDates : openDates).add(d.toISOString().slice(0, 10));
        }
        expect(data.orders.some((o) => closedDates.has(o.business_date))).toBe(false);
        expect(data.timecards.some((t) => closedDates.has(localParts(t.clock_in, cafe.timezone).date))).toBe(false);
        expect(data.dailyRollups.map((r) => r.business_date).sort()).toEqual([...openDates].sort());
      });

      it("keeps daily totals equal to the sum of that day's orders", () => {
        for (const day of data.dailyRollups) {
          const dayOrders = data.orders.filter((o) => o.business_date === day.business_date);
          expect(dayOrders.length).toBe(day.orders_count);
          expect(dayOrders.reduce((s, o) => s + o.net_sales_cents, 0)).toBe(day.net_sales_cents);
          expect(dayOrders.reduce((s, o) => s + o.processing_fee_cents, 0)).toBe(day.card_fees_cents);
        }
      });
    });
  }

  it("gives the same rows for the same inputs", () => {
    const cafe = TEST_CAFES[0];
    const a = generateDemoData({ businessId: cafe.businessId, endDateStr, days: 7, cafe });
    const b = generateDemoData({ businessId: cafe.businessId, endDateStr, days: 7, cafe });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("localTimeToUtcIso", () => {
  it("follows each time zone's daylight-saving changes", () => {
    expect(localTimeToUtcIso("2026-10-30", 6, 0, "America/New_York")).toBe("2026-10-30T10:00:00.000Z");
    expect(localTimeToUtcIso("2026-11-02", 6, 0, "America/New_York")).toBe("2026-11-02T11:00:00.000Z");
    expect(localTimeToUtcIso("2026-10-23", 8, 0, "Europe/Madrid")).toBe("2026-10-23T06:00:00.000Z");
    expect(localTimeToUtcIso("2026-10-26", 8, 0, "Europe/Madrid")).toBe("2026-10-26T07:00:00.000Z");
  });
});

describe("latestClosedDate", () => {
  it("is yesterday in the café that is furthest behind", () => {
    // 02:00 UTC on Nov 5 is still Nov 4 in New York, already Nov 5 in Madrid.
    expect(latestClosedDate(TEST_CAFES, new Date("2026-11-05T02:00:00Z"))).toBe("2026-11-03");
  });
});
