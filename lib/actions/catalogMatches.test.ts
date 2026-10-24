import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { addUploadedItemToMenu, matchUploadedItem } from "./catalogMatches";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn() }));
vi.mock("@/lib/data/queryError", () => ({ logQueryError: vi.fn() }));
vi.mock("@/lib/menu/menuGroups", () => ({
  existingMenuGroups: vi.fn(async () => []),
  normalizeMenuGroup: vi.fn((name: string) => name),
}));

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const MATCH = "33333333-3333-4333-8333-333333333333";

function fakeDb(count: number, options?: { failLineBatch?: number; noExistingItem?: boolean }) {
  const orders = Array.from({ length: count }, (_, i) => ({
    id: `order-${String(i).padStart(5, "0")}`, business_id: BUSINESS, pos_order_id: `csv-${i}`,
  }));
  const lines = orders.map(order => ({order_id: order.id, name: "Iced mocha", menu_item_id: null as string | null}));
  const groups = [{ item_name: "Iced mocha", menu_item_id: null as string | null }];
  const match = { id: MATCH, business_id: BUSINESS, provider: "csv", status: "needs_review",
    pos_item_id: "csv-item-iced-mocha", imported_name: "Iced mocha", imported_price_cents: 525,
    imported_category: null, suggested_menu_item_id: null };
  const items = options?.noExistingItem ? [] as {id:string;pos_item_id:string|null}[] : [{id:ITEM,pos_item_id:null as string|null}];
  const ranges: number[][] = [];
  const lineBatches: number[] = [];
  let failed = false;
  let creates = 0;
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: "user" } } }) },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      let insertValue: Record<string, unknown> | null = null;
      const q = {
        select: (_columns?: string) => q,
        eq: (field: string, value: unknown) => {filters[field] = value;return q;},
        like: (field: string, value: unknown) => {filters[field] = value;return q;},
        is: (field: string, value: unknown) => {filters[field] = value;return q;},
        in: (field: string, value: unknown) => {filters[field] = value;return q;},
        order: (_field: string, _options?: unknown) => q,
        update: (values: Record<string, unknown>) => { patch = values; return q; },
        insert: (values: Record<string, unknown>) => {insertValue = values; return q;},
        range: async (first: number, last: number) => {
          if (table !== "orders") throw new Error("Unexpected page table");
          ranges.push([first,last]);
          return { data: orders.slice(first,last+1), error: null };
        },
        single: async () => one(),
        maybeSingle: async () => one(),
        then: (resolve: (value: unknown) => unknown) => resolve(runWrite()),
      };
      function one() {
        if (insertValue && table === "menu_items") {
          creates++;
          items.push({id: ITEM, pos_item_id: String(insertValue.pos_item_id)});
          return {data:{id:ITEM},error:null};
        }
        if (table === "pos_catalog_matches" && filters.id === MATCH && match.status === filters.status
          && (!filters.provider || match.provider === filters.provider) && filters.business_id === BUSINESS)
          return {data:match,error:null};
        if (table === "menu_items" && filters.business_id === BUSINESS) {
          const item = items.find(row => row.id === filters.id || row.pos_item_id === filters.pos_item_id);
          return {data:item ?? null,error:null};
        }
        return {data:null,error:null};
      }
      function runWrite() {
        if (!patch) return {data:[],error:null};
        if (table === "menu_items") {
          const item = items.find(row => row.id === filters.id);
          if (item) item.pos_item_id = patch.pos_item_id as string;
        }
        if (table === "order_lines") {
          const ids = filters.order_id as string[];
          lineBatches.push(ids.length);
          if (!failed && options?.failLineBatch === lineBatches.length) {
            failed = true;
            return {error:{message:"temporary line update failure"}};
          }
          for (const line of lines) {
            if (ids.includes(line.order_id) && line.name === filters.name && line.menu_item_id === null)
              line.menu_item_id = patch.menu_item_id as string;
          }
        }
        if (table === "csv_sales_import_groups") {
          for (const group of groups) if (group.item_name === filters.item_name && group.menu_item_id === null)
            group.menu_item_id = patch.menu_item_id as string;
        }
        if (table === "pos_catalog_matches" && filters.id === MATCH && match.status === filters.status)
          match.status = patch.status as string;
        return {error:null};
      }
      return q;
    },
  };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(db as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
  return {lines,groups,match,items,ranges,lineBatches,get creates(){return creates;}};
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveBusinessId).mockResolvedValue(BUSINESS);
});

describe("CSV match backfill", () => {
  it("links 1,205 historical sales across all pages before confirming", async () => {
    const fake = fakeDb(1205);
    const form = new FormData(); form.set("menuItemId",ITEM);
    await matchUploadedItem(MATCH,form);
    expect(fake.ranges).toEqual([[0,499],[500,999],[1000,1499]]);
    expect(fake.lineBatches.length).toBe(13);
    expect(Math.max(...fake.lineBatches)).toBeLessThanOrEqual(100);
    expect(fake.lines.every(line => line.menu_item_id === ITEM)).toBe(true);
    expect(fake.groups[0].menu_item_id).toBe(ITEM);
    expect(fake.match.status).toBe("confirmed");
  });

  it("keeps a match open after a partial write so a retry repairs all sales", async () => {
    const fake = fakeDb(220,{failLineBatch:2});
    const form = new FormData();form.set("menuItemId",ITEM);
    await matchUploadedItem(MATCH,form);
    expect(fake.match.status).toBe("needs_review");
    expect(fake.groups[0].menu_item_id).toBeNull();
    expect(fake.lines.some(row => row.menu_item_id === null)).toBe(true);
    await matchUploadedItem(MATCH,form);
    expect(fake.match.status).toBe("confirmed");
    expect(fake.lines.every(line => line.menu_item_id === ITEM)).toBe(true);
  });

  it("Add to menu creates one item and backfills existing sales", async () => {
    const fake = fakeDb(1105,{noExistingItem:true});
    await addUploadedItemToMenu(MATCH);
    expect(fake.creates).toBe(1);
    expect(fake.match.status).toBe("confirmed");
    expect(fake.lines.every(line => line.menu_item_id === ITEM)).toBe(true);
  });

  it("does not confirm an item from another café", async () => {
    const fake = fakeDb(2);
    const form = new FormData();form.set("menuItemId","aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    await matchUploadedItem(MATCH,form);
    expect(fake.match.status).toBe("needs_review");
    expect(fake.lines.every(line => line.menu_item_id === null)).toBe(true);
  });
});
