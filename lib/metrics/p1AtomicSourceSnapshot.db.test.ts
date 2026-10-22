import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import pg from "pg";
import { atomicP1SourceSchema } from "./p1AtomicSourceSnapshot.server";
import { extractAtomicSnapshot } from "./p1AtomicSnapshotProjection";

const enabled=process.env.P1_DISPOSABLE_DB==="1";
const cafe="a12a12a1-1111-4111-8111-a12a12a12a12";
const user="a12a12a1-2222-4222-8222-a12a12a12a12";

describe.skipIf(!enabled)("real PostgreSQL authoritative P1 snapshot schema",()=>{
  it("parses the full single-RPC, owner-bound actual DB payload without coercion",async()=>{
    const client=new pg.Client({host:"127.0.0.1",port:54322,
      database:"postgres",user:"postgres",password:"postgres"});
    await client.connect();
    try{
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
      const response=await client.query(
        "SELECT public.p1_authoritative_source_snapshot($1) AS payload",[cafe]);
      const parsed=atomicP1SourceSchema.safeParse(response.rows[0]?.payload);
      if(!parsed.success)throw new Error(JSON.stringify(parsed.error.issues));
      const data=parsed.data;
      expect(data.businessId).toBe(cafe);
      expect(data.revision).toMatch(/^[1-9]\d*$/);
      expect(data.coverage).toBe("not_proven_by_revision");
      expect(data.sources.menu.find(m=>m.name==="Iced latte")?.price_cents).toBe(600);
      expect(data.sources.employees.find(e=>e.display_name==="Sophie")
        ?.default_hourly_wage_cents).toBe(1900);
      expect(data.sources.imports.some(job=>job.kind==="sales")).toBe(true);
      // The same real SQL payload drives the bounded projection: no independently
      // selected menu, wage or pricing SELECT is injected into these values.
      const item="a12a12a1-4444-4444-8444-a12a12a12a12";
      const economics=extractAtomicSnapshot("menu.product_economics",
        data,{productId:item},"2026-10-15");
      expect(economics?.leaves).toEqual(expect.arrayContaining([
        expect.objectContaining({field:"priceCents",value:600}),
        expect.objectContaining({field:"ingredientsCentsToday",value:0}),
      ]));
      // Real authenticated INSERT and same-transaction STABLE snapshot prove
      // that the JSON timestamp, money, tenant and source fields match Zod.
      // This entire fixture is rolled back: no production/committed mutation.
      await client.query("INSERT INTO public.menu_item_cost_fallbacks "+
        "(business_id,menu_item_id,cost_cents,source_type,status,source_label) "+
        "VALUES ($1,$2,175,'owner_manual','confirmed','Owner-entered demo cost')",
      [cafe,item]);
      const withTotal=await client.query(
        "SELECT public.p1_authoritative_source_snapshot($1) AS payload",[cafe]);
      const ownerCost=atomicP1SourceSchema.parse(withTotal.rows[0]?.payload);
      expect(BigInt(ownerCost.revision)>BigInt(data.revision)).toBe(true);
      expect(ownerCost.truncated.ownerTotalCosts).toBe(false);
      expect(ownerCost.sources.ownerTotalCosts).toEqual([
        expect.objectContaining({
          menu_item_id:item,cost_cents:175,source_type:"owner_manual",
          status:"confirmed",source_label:"Owner-entered demo cost",
          updated_at:expect.any(String),
        }),
      ]);
      expect(ownerCost.sources.recipes).toEqual(data.sources.recipes);
      const wages=extractAtomicSnapshot("labor.employee_wages",data,{},"2026-10-15");
      expect(wages?.leaves).toEqual(expect.arrayContaining([
        expect.objectContaining({name:"Sophie",value:1900}),
      ]));
      const burden=extractAtomicSnapshot("labor.payroll_burden",data,{},"2026-10-15");
      expect(burden?.leaves).toEqual(expect.arrayContaining([
        expect.objectContaining({field:"rateBasisPoints",value:1300}),
      ]));
      expect(data.coverage).toBe("not_proven_by_revision");
      await client.query("ROLLBACK");
    }finally{await client.end();}
  });
});
