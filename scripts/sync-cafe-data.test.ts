import { describe, expect, it, beforeEach } from "vitest";
import {
  uuidv5,
  remapId,
  idOverrides,
  toParam,
  remapRow,
  wrapClientForSafety,
  INSERT_IF_MISSING_TABLES,
  REFRESH_WINDOW_TABLES,
  SOURCE_BUSINESS_ID,
  DEST_BUSINESS_ID,
} from "./sync-cafe-data.mjs";

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
