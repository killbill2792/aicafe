import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/metrics/p1Readers.server",async original=>({...await original<object>(),authorizedOwnerP1:vi.fn()}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({readAuthorizedAtomicP1SourceSnapshot:vi.fn()}));
vi.mock("@/lib/scheduling/oliviaCapabilities.server",()=>({executeOliviaReadCapability:vi.fn()}));
vi.mock("@/lib/ai/suppliers/research.server",()=>({researchEnabled:vi.fn(()=>false),researchPublicSources:vi.fn()}));
import {friendlyAgent} from "./runInvestigation.server";

describe("friendlyAgent",()=>{
  it("maps every registered P1 catalog owner prefix to its real specialist, never the generic fallback",()=>{
    expect(friendlyAgent("alex")).toBe("alex");
    expect(friendlyAgent("menu")).toBe("alex");
    expect(friendlyAgent("pricing")).toBe("alex");
    expect(friendlyAgent("olivia")).toBe("olivia");
    expect(friendlyAgent("labor")).toBe("olivia");
    expect(friendlyAgent("money")).toBe("leo");
    expect(friendlyAgent("sales")).toBe("leo");
    expect(friendlyAgent("maya")).toBe("maya");
    expect(friendlyAgent("team")).toBe("maya");
    expect(friendlyAgent("supplies")).toBe("maya");
  });
  it("falls back to the generic supervisor label only for an unknown owner",()=>{
    expect(friendlyAgent("platform")).toBe("supervisor");
    expect(friendlyAgent("energy")).toBe("supervisor");
    expect(friendlyAgent(undefined)).toBe("supervisor");
  });
});
