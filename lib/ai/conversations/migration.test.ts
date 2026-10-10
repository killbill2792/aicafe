import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** Static migration safety checks. A production RLS smoke test still requires an
 * explicitly reconciled database; these checks intentionally do not claim to run SQL.
 */
const sql = readFileSync(
  new URL("../../../supabase/migrations/20261010000033_ai_conversations.sql", import.meta.url),
  "utf8",
);

describe("Supervisor conversation migration contract", () => {
  it("stores conversations for a specific owner and café", () => {
    expect(sql).toContain("owner_user_id uuid not null references auth.users(id)");
    expect(sql).toContain("business_id uuid not null references businesses(id)");
    expect(sql).toContain("unique (business_id, owner_user_id, client_request_id)");
    expect(sql).toContain("foreign key (business_id, thread_id, owner_user_id)");
    expect(sql).toContain("unique (thread_id, client_message_id)");
  });

  it("enables row-level security and scopes policies to the current owner", () => {
    expect(sql).toContain("alter table ai_threads enable row level security");
    expect(sql).toContain("alter table ai_messages enable row level security");
    expect(sql).toContain("owner_user_id = (select auth.uid())");
    expect(sql).toContain("m.role = 'owner'");
    expect(sql).toContain("to authenticated");
  });

  it("has no client policy for Supervisor message impersonation or editing history", () => {
    expect(sql).toContain("role = 'owner'");
    expect(sql).toContain("author_user_id = (select auth.uid())");
    expect(sql).toContain("revoke update, delete on ai_threads, ai_messages");
    expect(sql).not.toMatch(/create policy[^;]+for update/);
    expect(sql).not.toMatch(/create policy[^;]+for delete/);
    expect(sql).not.toMatch(/create policy[^;]+for all/);
  });

  it("only allows Supervisor structured content to carry explicit grounding", () => {
    expect(sql).toContain("grounding is not null");
    expect(sql).toContain("jsonb_typeof(structured_content) = 'array'");
    expect(sql).toContain("('verified', 'estimated', 'insufficient_evidence')");
    expect(sql).toContain("text_content is null");
  });
});
