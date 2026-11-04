import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../supabase/migrations/20261104000149_whatsapp_owner_provenance.sql",import.meta.url),"utf8");

describe("WhatsApp owner provenance migration",()=>{
  it("lets owner rows carry only the exact WhatsApp stamp",()=>{
    expect(sql).toContain("grounding is null or (");
    expect(sql).toContain("grounding->>'sourceChannel' = 'whatsapp'");
    expect(sql).toContain("(grounding - 'sourceChannel' - 'receivedAt' - 'attachmentIds') = '{}'::jsonb");
    expect(sql).toContain("jsonb_array_length(grounding->'attachmentIds') <= 3");
  });
  it("keeps every supervisor-row rule",()=>{
    expect(sql).toContain("jsonb_array_length(structured_content) between 1 and 30");
    expect(sql).toContain("'insufficient_evidence','requires_owner_input'");
    expect(sql).toContain("jsonb_typeof(grounding->'ownerInput') = 'object'");
  });
  it("never lets a website insert stamp provenance",()=>{
    const policy=sql.slice(sql.indexOf("create policy"));
    expect(policy).toContain("for insert to authenticated");
    expect(policy).toContain("and grounding is null");
    expect(policy).toContain("m.role = 'owner'");
  });
});
