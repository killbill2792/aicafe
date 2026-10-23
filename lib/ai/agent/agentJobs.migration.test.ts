import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** Static checks only (no database here); mirrors lib/ai/conversations/migration.test.ts. */
const sql = readFileSync(new URL("../../../supabase/migrations/20261023000086_agent_jobs.sql", import.meta.url), "utf8");

describe("agent jobs migration contract", () => {
  it("scopes every job to one owner, café and conversation", () => {
    expect(sql).toContain("create table if not exists public.ai_agent_jobs");
    expect(sql).toMatch(/foreign key \(business_id, thread_id, owner_user_id\)/u);
    expect(sql).toContain("unique (owner_message_id)");
  });
  it("enables RLS with an owner-only read policy and no client writes", () => {
    expect(sql).toContain("alter table public.ai_agent_jobs enable row level security");
    expect(sql).toContain("owner_user_id = (select auth.uid())");
    expect(sql).toMatch(/revoke insert, update, delete[^;]*on public\.ai_agent_jobs from[^;]*authenticated/u);
  });
  it("allows one running job per conversation and never a silent failure", () => {
    expect(sql).toMatch(/create unique index[^;]*where status = 'running'/u);
    expect(sql).toContain("status <> 'failed' or error_code is not null");
  });
  it("keeps job functions server-only", () => {
    for (const fn of ["ai_agent_job_start", "ai_agent_job_progress", "ai_agent_job_take_inbox", "ai_agent_job_finish"]) {
      expect(sql).toContain("function public." + fn);
      expect(sql).toMatch(new RegExp("revoke all on function public\\." + fn + "[^;]*from public, anon, authenticated", "u"));
      expect(sql).toMatch(new RegExp("grant execute on function public\\." + fn + "[^;]*to service_role", "u"));
    }
    expect(sql.match(/security definer/gu)?.length).toBe(4);
    expect(sql.match(/set search_path = public/gu)?.length).toBe(4);
  });
  it("acknowledges follow-ups only at successful finish so timed-out inbox reads remain queued", () => {
    const take = sql.split("create or replace function public.ai_agent_job_take_inbox")[1]
      ?.split("create or replace function public.ai_agent_job_finish")[0];
    const finish = sql.split("create or replace function public.ai_agent_job_finish")[1];
    expect(take).toBeDefined();
    expect(take).not.toMatch(/set consumed\s*=/u);
    expect(finish).toContain("p_absorbed_ids uuid[]");
    expect(finish).toContain("set consumed = case when p_status = 'done'");
    expect(finish).toContain("not (coalesce(p_absorbed_ids, '{}'::uuid[]) <@ j.inbox)");
    expect(finish).toContain("not (m.id = any(j.consumed))");
  });
  it("publishes job changes for live progress only if Realtime exists", () => {
    expect(sql).toContain("supabase_realtime");
    expect(sql).toMatch(/if exists \(select 1 from pg_publication where pubname = 'supabase_realtime'\)/u);
  });
});
