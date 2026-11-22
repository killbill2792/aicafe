import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
const file=(name:string)=>readFileSync("supabase/migrations/"+name,"utf8");
describe("U4 additive SQL authorization, recovery and delivery invariants",()=>{
  it("reserves one-off original owner goal and DST-correct stored instant",()=>{
    const text=file("20261123000000_u4_once_objectives.sql");
    expect(text).toContain("u4_create_once_objective");
    expect(text).toContain("g.text_content");
    expect(text).toContain("owner_user_id=p_owner_user_id");
    expect(text).toContain("goal_source_message_id");
    expect(text).toContain("once_due_at_utc");
    expect(text).toContain("o.local_date=v.once_local_date and o.revision=v.revision");
    expect(text).toContain("supervisor_due_routine_dates");
    expect(text).toContain("claim_supervisor_routine_occurrence");
    expect(text).not.toContain("truncate public.ai_messages");
  });
  it("enforces service-only U4 admission, globally and per café",()=>{
    const text=file("20261123000002_u4_fair_admission.sql");
    expect(text).toContain("u4_due_objective_admission");
    expect(text).toContain("p_watch_enabled boolean default false");
    expect(text).toContain("pg_advisory_xact_lock");
    expect(text).toContain("u4_first_civil_due");
    expect(text).toContain("due.scheduled_for_utc>=r.updated_at");
    expect(text).toContain("due.scheduled_for_utc<=p_now");
    expect(text).toContain("o.lease_until>p_now");
    expect(text).toContain("v_global>=12 or v_cafe>=1");
    expect(text).toContain("abs(hashtext(v_o.run_id::text");
    expect(text).toContain("v_r.execution_mode in ('objective','watch')");

    expect(text).toContain("limit p_limit");
    expect(text).toContain("service_role");
  });
  it("delivers one Work report, only a short chat receipt and no foreign reads",()=>{
    const text=file("20261123000001_u4_work_delivery.sql");
    expect(text).toContain("operating_u4_report_owner_only");
    expect(text).toContain("u4_report_task_identity_conflict");
    const live=file("20261123000004_u4_push_publication.sql");
    expect(live).toContain("Luna review finished. Open Work");
    const registered=JSON.parse(readFileSync(".github/luna/scenarios/u4-autonomous-objectives.json","utf8"));
    expect(registered.assertions.some((a:{name:string})=>a.name==="private-work-pointer")).toBe(true);
    expect(text).toContain("'type','task_card'");
    expect(file("20261123000004_u4_push_publication.sql")).toContain("'type','task_card'");
    expect(text).toContain("'summary',btrim(p_report)");
    expect(text).not.toContain("substring(btrim(p_report) from n for 1200)");
    expect(text).toContain("revoke all on function public.u4_publish_objective_report");
    expect(file("20261123000005_u4_failure_notices.sql")).toContain("u4_acknowledge_failed_run");
  });
  it("stores only encrypted PWA keys and fences retries without new workflow",()=>{
    const text=file("20261123000003_u4_push_delivery.sql");
    expect(text).toContain("sealed_subscription text not null");
    expect(text).toContain("u4_close_revoked_push_receipts");
    expect(text).toContain("u4_reap_expired_push_receipts");
    expect(text).toContain("final_attempt_lease_expired");
    expect(text).toContain("for update of q skip locked");
    expect(text).toContain("t.created_at>=p_now-interval '7 days'");
    expect(text).toContain("newer.payload->>'routineId'=t.payload->>'routineId'");

    expect(text).toContain("for update of q skip locked");
    expect(text).toContain("attempts between 0 and 4");
    expect(text).toContain("enable row level security");
    expect(file("20261123000004_u4_push_publication.sql")).toContain("on conflict do nothing");
  });
});
