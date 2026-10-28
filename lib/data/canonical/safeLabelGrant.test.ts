import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
it("a redacted config label helper remains executable through the owner-invoker view",()=>{
 const migration=readFileSync(resolve("supabase/migrations/20261028000115_toast_safe_label_read_grant.sql"),"utf8");
 expect(migration).toContain("grant execute on function public.toast_safe_business_label(text) to authenticated");
});
