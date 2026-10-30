import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import {
  uuidv5,
  remapId,
  idOverrides,
  toParam,
  remapRow,
  wrapClientForSafety,
  INSERT_IF_MISSING_TABLES,
  REFRESH_WINDOW_TABLES,
  DAY_MIRROR_ORDER,
  daysToReplace,
  fingerprintIgnoredColumns,
  dayFingerprintSql,
  businessDaySql,
  orderByForeignKeys,
  SOURCE_BUSINESS_ID,
  DEST_BUSINESS_ID,
  syncTodayLive,
  remapToastGuidPrefix,
} from "./sync-cafe-data.mjs";
import pg from "pg";
import { extractUniqueConstraints } from "./migrationConstraints.mjs";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "supabase", "migrations");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  idOverrides.clear();
});

describe("uuidv5", () => {
  it("is deterministic for the same input", () => {
    expect(uuidv5("a")).toBe(uuidv5("a"));
  });

  it("differs for different input", () => {
    expect(uuidv5("a")).not.toBe(uuidv5("b"));
  });

  it("produces a well-formed v5 UUID (version and variant bits set)", () => {
    expect(uuidv5("anything")).toMatch(UUID_RE);
  });
});

describe("remapId", () => {
  it("is deterministic for the same table + source id", () => {
    expect(remapId("orders", "src-1")).toBe(remapId("orders", "src-1"));
  });

  it("differs across tables for the same source id (no accidental cross-table collisions)", () => {
    expect(remapId("orders", "src-1")).not.toBe(remapId("menu_items", "src-1"));
  });

  it("differs across source ids for the same table", () => {
    expect(remapId("orders", "src-1")).not.toBe(remapId("orders", "src-2"));
  });

  it("honors an override (e.g. a starter-pack ingredient matched to an existing dest row)", () => {
    const destId = "11111111-1111-1111-1111-111111111111";
    idOverrides.set("ingredients|src-milk", destId);
    expect(remapId("ingredients", "src-milk")).toBe(destId);
  });
});

describe("toParam", () => {
  it("passes a native-array column through as a raw array, not JSON", () => {
    expect(toParam("available_days", [1, 2, 3])).toEqual([1, 2, 3]);
    expect(toParam("unavailable_weekdays", [0, 6])).toEqual([0, 6]);
    expect(toParam("flagged_dates", [])).toEqual([]);
  });

  it("JSON-encodes a jsonb-shaped array or object column", () => {
    expect(toParam("payload", { a: 1 })).toBe(JSON.stringify({ a: 1 }));
    expect(toParam("modifiers", [{ name: "oat milk" }])).toBe(JSON.stringify([{ name: "oat milk" }]));
  });

  it("passes null/undefined through as null", () => {
    expect(toParam("anything", null)).toBeNull();
    expect(toParam("anything", undefined)).toBeNull();
  });

  it("serializes a Date as an ISO string", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(toParam("created_at", d)).toBe(d.toISOString());
  });

  it("passes primitives through unchanged", () => {
    expect(toParam("name", "Milk")).toBe("Milk");
    expect(toParam("price_cents", 500)).toBe(500);
  });
});

describe("remapRow", () => {
  const cfg = { remapOwnId: true, fk: { location_id: "locations", employee_id: "employees" }, nullOut: ["proposal_id"] };

  it("always swaps business_id to the destination", () => {
    const out = remapRow("orders", { id: "o1", business_id: SOURCE_BUSINESS_ID, location_id: "l1" }, cfg);
    expect(out.business_id).toBe(DEST_BUSINESS_ID);
  });

  it("remaps its own id when remapOwnId is set", () => {
    const out = remapRow("orders", { id: "o1", business_id: SOURCE_BUSINESS_ID }, cfg);
    expect(out.id).toBe(remapId("orders", "o1"));
    expect(out.id).not.toBe("o1");
  });

  it("remaps every configured FK column, and leaves null FKs null", () => {
    const out = remapRow("orders", { id: "o1", business_id: SOURCE_BUSINESS_ID, location_id: "l1", employee_id: null }, cfg);
    expect(out.location_id).toBe(remapId("locations", "l1"));
    expect(out.employee_id).toBeNull();
  });

  it("does not remap a column that isn't listed in fk (e.g. orders.superseded_by, a plain text marker)", () => {
    const out = remapRow("orders", { id: "o1", business_id: SOURCE_BUSINESS_ID, superseded_by: "toast" }, cfg);
    expect(out.superseded_by).toBe("toast");
  });

  it("nulls out every column listed in nullOut", () => {
    const out = remapRow("orders", { id: "o1", business_id: SOURCE_BUSINESS_ID, proposal_id: "p1" }, cfg);
    expect(out.proposal_id).toBeNull();
  });

  it("leaves a row with no business_id column alone (join-scoped tables)", () => {
    const out = remapRow("recipe_lines", { menu_item_id: "m1", ingredient_id: "i1" }, { fk: { menu_item_id: "menu_items", ingredient_id: "ingredients" } });
    expect(out).not.toHaveProperty("business_id");
    expect(out.menu_item_id).toBe(remapId("menu_items", "m1"));
  });
});

describe("table configuration sanity", () => {
  it("never configures orders.superseded_by for remapping (it's a plain text marker like 'toast', not an id)", () => {
    const orders = INSERT_IF_MISSING_TABLES.concat(REFRESH_WINDOW_TABLES).find((c) => c.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.fk).not.toHaveProperty("superseded_by");
  });

  it("every refresh-window table has a non-empty primary key", () => {
    for (const cfg of REFRESH_WINDOW_TABLES) {
      expect(cfg.pk.length).toBeGreaterThan(0);
    }
  });

  it("every insert-if-missing table has a non-empty primary key", () => {
    for (const cfg of INSERT_IF_MISSING_TABLES) {
      expect(cfg.pk.length).toBeGreaterThan(0);
    }
  });

  it("keeps the ingredients table's starter-pack dedupe column configured", () => {
    const ingredients = INSERT_IF_MISSING_TABLES.find((c) => c.table === "ingredients");
    expect(ingredients?.matchColumn).toBe("starter_key");
  });

  it("source and destination business ids are distinct", () => {
    expect(SOURCE_BUSINESS_ID).not.toBe(DEST_BUSINESS_ID);
  });

  it("employee_sales_rollup and hourly_sales_rollup use plain inserts, not an ON CONFLICT target that doesn't exist in migrations", () => {
    for (const name of ["employee_sales_rollup", "hourly_sales_rollup"]) {
      const cfg = REFRESH_WINDOW_TABLES.find((c) => c.table === name);
      expect(cfg?.conflictMode).toBe("plain");
    }
  });

  it("ingredient_unit_conversions uses a targetless ON CONFLICT (it has two overlapping unique constraints)", () => {
    const cfg = INSERT_IF_MISSING_TABLES.find((c) => c.table === "ingredient_unit_conversions");
    expect(cfg?.conflictMode).toBe("none");
  });

  it("toast_location_mappings resets verified_at and every scheduler tick/lease column, even on an existing row", () => {
    const cfg = INSERT_IF_MISSING_TABLES.find((c) => c.table === "toast_location_mappings");
    expect(cfg?.nullOut).toEqual(expect.arrayContaining(["verified_at", "info_refreshed_at", "last_tick_started_at"]));
    expect(cfg?.setValues).toEqual({ recheck_total: 0 });
    expect(cfg?.conflictMode).toBe("updateSafetyColumns");
    expect(cfg?.updateColumnsOnConflict).toEqual(expect.arrayContaining(["verified_at", "info_refreshed_at", "last_tick_started_at", "recheck_total"]));
  });

  it("toast_day_status, toast_day_owner_flags and pos_scheduled_shifts live in the refresh window, not insert-if-missing", () => {
    for (const name of ["toast_day_status", "toast_day_owner_flags", "pos_scheduled_shifts"]) {
      expect(REFRESH_WINDOW_TABLES.some((c) => c.table === name)).toBe(true);
      expect(INSERT_IF_MISSING_TABLES.some((c) => c.table === name)).toBe(false);
    }
  });

  it("timecards and pos_scheduled_shifts window against their own timestamp column, not business_date", () => {
    expect(REFRESH_WINDOW_TABLES.find((c) => c.table === "timecards")?.dateColumn).toBe("clock_in");
    expect(REFRESH_WINDOW_TABLES.find((c) => c.table === "pos_scheduled_shifts")?.dateColumn).toBe("scheduled_start");
  });

  it("order_lines has no date column of its own — must be windowed by its parent order's business_date", () => {
    const orderLines = REFRESH_WINDOW_TABLES.find((c) => c.table === "order_lines");
    expect(orderLines?.joinScope).toBe("orders");
    expect(orderLines?.dateColumn).toBe("business_date");
  });
});

describe("remapRow: setValues", () => {
  it("forces a literal value after remap and nullOut, regardless of the source value", () => {
    const cfg = { nullOut: [], setValues: { recheck_total: 0 } };
    const out = remapRow("toast_location_mappings", { business_id: SOURCE_BUSINESS_ID, recheck_total: 42 }, cfg);
    expect(out.recheck_total).toBe(0);
  });
});

describe("every configured ON CONFLICT target matches a real constraint declared in supabase/migrations", () => {
  const constraintsByTable: Map<string, string[][]> = extractUniqueConstraints(MIGRATIONS_DIR);

  function assertHasMatchingConstraint(cfg: { table: string; pk: string[] }) {
    const expected = [...cfg.pk].map((c) => c.toLowerCase()).sort();
    const candidates: string[][] = constraintsByTable.get(cfg.table.toLowerCase()) ?? [];
    const matches = candidates.some((cols) => cols.length === expected.length && cols.every((c, i) => c === expected[i]));
    expect(matches, `${cfg.table}: configured pk [${expected.join(",")}] has no matching PRIMARY KEY/UNIQUE constraint among ${JSON.stringify(candidates)} in supabase/migrations`).toBe(true);
  }

  it("holds for every insert-if-missing table using a named conflict target", () => {
    for (const cfg of INSERT_IF_MISSING_TABLES) {
      if (cfg.conflictMode === "none" || cfg.conflictMode === "plain") continue;
      assertHasMatchingConstraint(cfg);
    }
  });

  it("holds for every refresh-window table using a named conflict target", () => {
    for (const cfg of REFRESH_WINDOW_TABLES) {
      if (cfg.conflictMode === "none" || cfg.conflictMode === "plain") continue;
      assertHasMatchingConstraint(cfg);
    }
  });

  it("confirms employee_sales_rollup and hourly_sales_rollup genuinely have no such constraint (why they use plain inserts instead)", () => {
    expect(constraintsByTable.get("employee_sales_rollup")).toBeUndefined();
    expect(constraintsByTable.get("hourly_sales_rollup")).toBeUndefined();
  });
});

interface FakeQueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

describe("wrapClientForSafety", () => {
  function fakeClient(): FakeQueryClient {
    return {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    };
  }

  it("refuses an insert whose parameters reference SOURCE_BUSINESS_ID", () => {
    const client = wrapClientForSafety(fakeClient());
    expect(() => client.query("insert into orders (business_id) values ($1)", [SOURCE_BUSINESS_ID])).toThrow(/safety violation/);
  });

  it("refuses an update or delete whose parameters reference SOURCE_BUSINESS_ID", () => {
    const client = wrapClientForSafety(fakeClient());
    expect(() => client.query("update orders set x = 1 where business_id = $1", [SOURCE_BUSINESS_ID])).toThrow(/safety violation/);
    expect(() => client.query("delete from orders where business_id = $1", [SOURCE_BUSINESS_ID])).toThrow(/safety violation/);
  });

  it("allows a read (select) that references SOURCE_BUSINESS_ID", async () => {
    const client = wrapClientForSafety(fakeClient());
    await expect(client.query("select * from orders where business_id = $1", [SOURCE_BUSINESS_ID])).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  it("allows a write scoped only to DEST_BUSINESS_ID", async () => {
    const client = wrapClientForSafety(fakeClient());
    await expect(client.query("insert into orders (business_id) values ($1)", [DEST_BUSINESS_ID])).resolves.toEqual({ rows: [], rowCount: 0 });
  });
});

describe("syncTodayLive", () => {
  const reading = { provisional: true, businessDate: "2026-10-29", netSalesCents: 45575 };
  function fakeClient(sourceRows: unknown[] | Error) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return { calls, client: { query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/^\s*select/i.test(sql)) { if (sourceRows instanceof Error) throw sourceRows; return { rows: sourceRows }; }
      return { rows: [] };
    } } };
  }
  it("copies the source café's live reading to the test café only", async () => {
    const { client, calls } = fakeClient([{ business_date: "2026-10-29", read_at: new Date("2026-10-29T18:15:04Z"),
      net_sales_cents: 45575, orders: 45, reading }]);
    expect(await syncTodayLive(client)).toBe(1);
    const write = calls[1];
    expect(write.sql).toMatch(/^\s*insert into toast_today_live/);
    expect(write.params[0]).toBe(DEST_BUSINESS_ID);
    expect(write.params).not.toContain(SOURCE_BUSINESS_ID);
    expect(write.params[5]).toBe(JSON.stringify(reading));
  });
  it("does nothing when there is no reading or the table is not installed yet", async () => {
    expect(await syncTodayLive(fakeClient([]).client)).toBe(0);
    expect(await syncTodayLive(fakeClient(Object.assign(new Error("missing"), { code: "42P01" })).client)).toBe(0);
  });
});

describe("day mirror", () => {
  it("replaces only the days whose rows differ, including days only one café has", () => {
    const source = new Map([["2026-08-22", "a"], ["2026-08-23", "b"], ["2026-08-25", "late"]]);
    const dest = new Map([["2026-08-22", "a"], ["2026-08-23", "old"], ["2026-08-24", "gone"]]);
    expect(daysToReplace(source, dest)).toEqual(["2026-08-23", "2026-08-24", "2026-08-25"]);
  });
  it("replaces nothing when every day matches, and everything on a forced full copy", () => {
    const same = new Map([["2026-08-22", "a"]]);
    expect(daysToReplace(same, new Map(same))).toEqual([]);
    expect(daysToReplace(same, new Map(same), true)).toEqual(["2026-08-22"]);
  });
  it("leaves own ids, reset and dropped columns out of the fingerprint, but compares links", () => {
    const tc = REFRESH_WINDOW_TABLES.find((c) => c.table === "timecards");
    expect(fingerprintIgnoredColumns(tc)).toEqual(["business_id", "id"]);
    const status = REFRESH_WINDOW_TABLES.find((c) => c.table === "toast_day_status");
    expect(fingerprintIgnoredColumns(status)).toContain("last_import_run_id");
    expect(fingerprintIgnoredColumns(status)).not.toContain("restaurant_guid");
    const refunds = REFRESH_WINDOW_TABLES.find((c) => c.table === "toast_refund_facts");
    expect(fingerprintIgnoredColumns(refunds)).toContain("id");
  });
  it("groups order lines by their order's day and keys them by the order's POS id", () => {
    const sql = dayFingerprintSql(REFRESH_WINDOW_TABLES.find((c) => c.table === "order_lines"));
    expect(sql).toContain("join orders p on t.order_id = p.id");
    expect(sql).toContain("p.pos_order_id");
    expect(sql).toContain("(p.business_date)::date");
  });
  it("mirrors every table in a parent-first order, and copies the payment, labor, void and refund facts", () => {
    expect([...DAY_MIRROR_ORDER].sort()).toEqual(REFRESH_WINDOW_TABLES.map((c) => c.table).sort());
    expect(DAY_MIRROR_ORDER.indexOf("orders")).toBeLessThan(DAY_MIRROR_ORDER.indexOf("order_lines"));
    for (const name of ["toast_payment_facts", "toast_payment_summaries", "toast_open_labor_summaries", "toast_void_facts", "toast_refund_facts"]) {
      expect(DAY_MIRROR_ORDER).toContain(name);
    }
  });
  it("never copies a refund's identity id", () => {
    const refunds = REFRESH_WINDOW_TABLES.find((c) => c.table === "toast_refund_facts");
    const out = remapRow("toast_refund_facts", { id: 7, business_id: SOURCE_BUSINESS_ID, restaurant_guid: "r", amount_cents: 5 }, refunds);
    expect(out).not.toHaveProperty("id");
    expect(out.business_id).toBe(DEST_BUSINESS_ID);
  });
});

describe("test café gets the Toast archive and daily captures (database behavior: sync-cafe-data-db-integration.mjs)", () => {
  it("points a copied archive row at the copied import run", () => {
    const archive = REFRESH_WINDOW_TABLES.find((c) => c.table === "toast_raw_records")!;
    const out = remapRow("toast_raw_records", { id: "a", business_id: SOURCE_BUSINESS_ID, restaurant_guid: "g", run_id: "r", seen_run_id: "r", payload: {} }, archive);
    expect(out.run_id).toBe(remapId("toast_sync_runs", "r"));
    expect(out.seen_run_id).toBeNull();
    expect(out.business_id).toBe(DEST_BUSINESS_ID);
  });
  it("passes capture field lists to Postgres as a real array", () => {
    expect(toParam("field_paths", ["a", "b"])).toEqual(["a", "b"]);
  });
  it("reads timestamps with their full precision, so unchanged days compare equal", () => {
    expect(pg.types.getTypeParser(1184)("2026-10-30 18:27:54.382047+00")).toBe("2026-10-30 18:27:54.382047+00");
    expect(pg.types.getTypeParser(1082)("2026-10-30")).toBe("2026-10-30");
  });
});

describe("Financial Fix B: source/test safety and café-local parity", () => {
  it("partitions late UTC timecards on the café-local business date", () => {
    const timecards = REFRESH_WINDOW_TABLES.find((cfg) => cfg.table === "timecards")!;
    const open = REFRESH_WINDOW_TABLES.find((cfg) => cfg.table === "toast_open_labor_summaries")!;
    const shifts = REFRESH_WINDOW_TABLES.find((cfg) => cfg.table === "pos_scheduled_shifts")!;
    for (const cfg of [timecards, open, shifts]) {
      expect(cfg.localDay).toBe(true);
      const sql = dayFingerprintSql(cfg);
      expect(sql).toContain("at time zone (select timezone from businesses");
      expect(sql).toContain("::date");
    }
    expect(businessDaySql(timecards, "t")).toContain("t.clock_in");
    expect(businessDaySql(REFRESH_WINDOW_TABLES.find((cfg) => cfg.table === "orders")!, "t"))
      .toBe("(t.business_date)::date");
  });

  it("orders mirroring by live FK parents even when the static order is wrong", () => {
    expect(orderByForeignKeys(["child", "parent", "grandchild"], [
      { child: "child", parent: "parent" }, { child: "grandchild", parent: "child" },
    ])).toEqual(["parent", "child", "grandchild"]);
    expect(() => orderByForeignKeys(["a", "b"], [
      { child: "a", parent: "b" }, { child: "b", parent: "a" },
    ])).toThrow(/FK cycle/);
  });

  it("refreshes existing copied economic sources, not source credentials or café identity", () => {
    for (const name of ["employees", "recurring_costs", "expenses", "processing_fee_rate_plans", "employee_pay_period_facts"]) {
      const cfg = INSERT_IF_MISSING_TABLES.find((x) => x.table === name)!;
      expect(cfg.conflictMode).toBe("updateSafetyColumns");
      expect(cfg.updateColumnsOnConflict?.length).toBeGreaterThan(0);
      expect(cfg.updateColumnsOnConflict).not.toContain("business_id");
      expect(cfg.updateColumnsOnConflict).not.toContain("confirmed_by");
    }
    expect(INSERT_IF_MISSING_TABLES.some((x) => x.table === "toast_api_credentials")).toBe(false);
    const directory = INSERT_IF_MISSING_TABLES.find((x) => x.table === "toast_employee_directory")!;
    expect(directory.fk?.linked_employee_id).toBe("employees");
    expect(directory.fk?.restaurant_guid).toBe("toast_restaurant_guid");
    expect(directory.pk).toEqual(["business_id", "restaurant_guid", "employee_guid"]);
  });
});

describe("Toast ids that embed the restaurant", () => {
  it("remaps the restaurant inside a timecard id the same way as restaurant_guid", () => {
    const guid = "a0000000-0000-4000-8000-000000000001";
    expect(remapToastGuidPrefix(`toast:${guid}:te-1`)).toBe(`toast:${remapId("toast_restaurant_guid", guid)}:te-1`);
    expect(remapToastGuidPrefix("manual-1")).toBe("manual-1");
    expect(remapToastGuidPrefix(null)).toBeNull();
    const tc = REFRESH_WINDOW_TABLES.find((c) => c.table === "timecards")!;
    expect(remapRow("timecards", { id: "x", business_id: SOURCE_BUSINESS_ID, pos_timecard_id: `toast:${guid}:te-1` }, tc).pos_timecard_id)
      .toBe(`toast:${remapId("toast_restaurant_guid", guid)}:te-1`);
  });
});
