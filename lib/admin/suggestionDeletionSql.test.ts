import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
const sql=readFileSync(
  new URL("../../supabase/migrations/20261023000089_admin_analytics.sql",import.meta.url),"utf8");
describe("admin suggestion deletion lifecycle",()=>{
  it("does not retain an auth user by restricting deletion",()=>{
    expect(sql).toContain("requested_by uuid references auth.users(id) on delete set null");
    expect(sql).toContain("alter column requested_by drop not null");
    expect(sql).toContain("drop constraint if exists admin_home_card_suggestions_requested_by_fkey");
    expect(sql).toContain("foreign key (requested_by) references auth.users(id) on delete set null");
    expect(sql).not.toContain("requested_by uuid not null references auth.users(id) on delete restrict");
  });
});
