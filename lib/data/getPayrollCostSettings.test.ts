import {expect,it,vi} from "vitest";

vi.mock("server-only",()=>({}));
const mock=vi.hoisted(()=>({
  configured:vi.fn(()=>false),
  makeClient:vi.fn(()=>{throw new Error("Offline preview must not access Supabase");}),
}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:mock.configured}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:mock.makeClient}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({
  getActiveBusinessId:vi.fn(()=>{throw new Error("Offline preview must not resolve a tenant");}),
}));

import {getPayrollCostSettings} from "./getPayrollCostSettings";

it("shows a clearly estimated, read-only-compatible payroll fallback without Supabase",async()=>{
  const result=await getPayrollCostSettings();
  expect(result).toEqual({
    employerCostRate:0.12,
    fallbackStatus:"estimated",
    fallbackSource:"system_estimate",
    actualSources:[],
  });
  expect(mock.makeClient).not.toHaveBeenCalled();
});
