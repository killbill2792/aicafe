import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe,expect,it} from "vitest";

/** Guard the migration delimiter failure that app-only CI could not detect. */
describe("staff workspace SQL deployment safety",()=>{
 const sql=readFileSync(join(process.cwd(),"supabase/migrations/20261022000081_staff_workspace.sql"),"utf8");
 it("uses complete dollar-quote delimiters for PL/pgSQL blocks",()=>{
   expect(sql).not.toMatch(/\bDO\s+\$(?!\$)/m);
   expect(sql).not.toMatch(/\bEND\s+\$(?!\$)/m);
   expect((sql.match(/\$\$/g)??[]).toHaveLength(4);
 });
 it("keeps existing employee history and uses an idempotent constraint guard",()=>{
   expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
   expect(sql).not.toMatch(/\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
   expect(sql).toContain("deleted_at");
 });
});
