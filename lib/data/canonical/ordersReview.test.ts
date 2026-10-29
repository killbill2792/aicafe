import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
it("does not hide imported excluded or superseded orders from owner canonical detail",()=>{
 const migration=readFileSync(resolve("supabase/migrations/20261028000116_toast_orders_review_rows.sql"),"utf8");
 const view=migration.split("create or replace view public.cv_orders")[1]?.split("revoke all")[0]??"";
 expect(view).toContain("'needs_match'");
 expect(view).toContain("o.toast_excluded is true");
 expect(view).toContain("o.superseded_by is not null");
 expect(view).not.toMatch(/\bwhere\b/i);
 expect(view).toContain("'toast_excluded'");
 expect(view).toContain("'superseded'");
});
