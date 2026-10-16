import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import pg from "pg";
import { atomicP1SourceSchema } from "./p1AtomicSourceSnapshot.server";

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
      await client.query("ROLLBACK");
    }finally{await client.end();}
  });
});
