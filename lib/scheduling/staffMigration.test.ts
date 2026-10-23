import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe,expect,it} from "vitest";

/** Database workflows replay every migration, but the baseline can catch
 * basic malformed SQL immediately before starting the disposable database. */
describe("staff workspace SQL deployment safety",()=>{
 const sql=readFileSync(join(process.cwd(),"supabase/migrations/20261022000081_staff_workspace.sql"),"utf8");

 it("uses complete dollar-quote delimiters for PL/pgSQL blocks",()=>{
   expect(sql).not.toMatch(/\bDO\s+\$(?!\$)/m);
   expect(sql).not.toMatch(/\bEND\s+\$(?!\$)/m);
   expect((sql.match(/\$\$/g)??[])).toHaveLength(4);
 });

 it("checks the authenticated staff RPC regression script's PL/pgSQL delimiters",()=>{
   const replay=readFileSync(join(process.cwd(),"scripts/staff-pr155-rls.sql"),"utf8");
   expect(replay).not.toMatch(/^\\s*(?:DO \\$|END \\$;)\\s*$/m);
   const opens=(replay.match(/^DO \\$\\$/gm)??[]).length;
   const closes=(replay.match(/^END \\$\\$;$/gm)??[]).length;
   expect(opens).toBeGreaterThan(0);
   expect(opens).toBe(closes);
 });

 it("balances structural parentheses without counting literals or SQL comments",()=>{
   const stripped=sql.replace(/'(?:''|[^'])*'/g,"''").replace(/--[^\n]*/g,"");
   let balance=0;
   for(const ch of stripped){
     if(ch==="(")balance++;
     if(ch===")")balance--;
     expect(balance).toBeGreaterThanOrEqual(0);
   }
   expect(balance).toBe(0);
 });

 it("keeps existing employee history and uses an idempotent constraint guard",()=>{
   expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
   expect(sql).not.toMatch(/\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
   expect(sql).toContain("deleted_at");
 });
});
