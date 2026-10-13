import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
const load=(name:string)=>readFileSync("supabase/migrations/"+name,"utf8");
describe("Toast staging DDL defense-in-depth contract",()=>{
  const initial=load("20261012000040_toast_secure_access.sql");
  const atomic=load("20261012000041_toast_atomic_configuration.sql");
  const throttle=load("20261012000047_toast_auth_throttle.sql");
  it("enforces RLS and explicit revocation of direct table access",()=>{
    expect(initial).toContain("toast_api_credentials ENABLE ROW LEVEL SECURITY");
    expect(initial).toContain("toast_location_mappings ENABLE ROW LEVEL SECURITY");
    expect(initial).toContain("FROM anon, authenticated");
    expect(atomic).toContain("FROM PUBLIC,anon,authenticated");
  });
  it("protects mappings with a composite tenant foreign key and uniqueness",()=>{
    expect(initial).toContain("toast_mapping_same_business");
    expect(initial).toContain("UNIQUE (business_id,location_id)");
  });
  it("changes credentials and mappings in one PostgreSQL transaction",()=>{
    const fn=atomic.split("CREATE OR REPLACE FUNCTION toast_save_configuration(")[1];
    expect(fn).toContain("INSERT INTO toast_api_credentials");
    expect(fn).toContain("DELETE FROM toast_location_mappings");
    expect(fn).toContain("INSERT INTO toast_location_mappings");
    expect(fn).toContain("configuration_version=toast_api_credentials.configuration_version+1");
  });
  it("limits RPC execution to service role",()=>{
    for(const action of ["toast_save_configuration","toast_invalidate_token_if_match","toast_commit_auth_token"])
      expect(atomic).toContain("REVOKE ALL ON FUNCTION "+action);
    expect(throttle).toContain("TO service_role");
    expect(throttle).toContain("retry_after IS NULL OR retry_after<=now()");
  });
});
