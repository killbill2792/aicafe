import {describe,expect,it} from "vitest";
import {validateResearchConnection} from "./u3ResearchConnection";

const project="https://syntheticresearchproject.supabase.co";
const ref="syntheticresearchproject";
describe("restricted research connection",()=>{
  it("allows the exact project-scoped Supabase session pooler identity",()=>{
    const url=`postgresql://aicafe_research.${ref}:testonly@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require`;
    expect(validateResearchConnection(url,project).username).toBe(`aicafe_research.${ref}`);
  });
  it("also permits transaction pooler, which keeps SET LOCAL inside a transaction",()=>{
    const url=`postgresql://aicafe_research.${ref}:testonly@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require`;
    expect(validateResearchConnection(url,project).port).toBe("6543");
  });
  it("rejects a pooler username for another café's Supabase project",()=>{
    const url="postgresql://aicafe_research.anotherproject:testonly@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
    expect(()=>validateResearchConnection(url,project)).toThrow("research_connection_untrusted");
  });
  it("rejects privileged login and lookalike pooler hosts",()=>{
    expect(()=>validateResearchConnection(
      "postgresql://postgres."+ref+":testonly@aws-0-us-west-1.pooler.supabase.com:5432/postgres",
      project)).toThrow("research_connection_untrusted");
    expect(()=>validateResearchConnection(
      `postgresql://aicafe_research.${ref}:testonly@aws-0-us-west-1.pooler.supabase.com.evil.org:5432/postgres`,
      project)).toThrow("research_connection_untrusted");
  });
  it("allows only the matching direct project endpoint",()=>{
    expect(validateResearchConnection(
      `postgresql://aicafe_research:testonly@db.${ref}.supabase.co:5432/postgres?sslmode=require`,project).username)
      .toBe("aicafe_research");
    expect(()=>validateResearchConnection(
      "postgresql://aicafe_research:testonly@db.otherproject.supabase.co:5432/postgres",project))
      .toThrow("research_connection_untrusted");
  });
  it("requires TLS for every external research connection",()=>{
    expect(()=>validateResearchConnection(
      `postgresql://aicafe_research.${ref}:testonly@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      project)).toThrow("research_connection_untrusted");
    expect(()=>validateResearchConnection(
      `postgresql://aicafe_research:testonly@db.${ref}.supabase.co:5432/postgres`,
      project)).toThrow("research_connection_untrusted");
  });
  it("rejects a missing secret or a wrong database",()=>{
    expect(()=>validateResearchConnection(
      `postgresql://aicafe_research.${ref}@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=require`,project))
      .toThrow("research_connection_untrusted");
    expect(()=>validateResearchConnection(
      `postgresql://aicafe_research.${ref}:testonly@aws-0-us-west-1.pooler.supabase.com:5432/other`,project))
      .toThrow("research_connection_untrusted");
  });
});
