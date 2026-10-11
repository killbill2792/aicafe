import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import cases from "./semantic-eval.fixture.json";
import { SUPERVISOR_FUNCTIONS } from "./toolRegistry.server";
describe("Supervisor semantic evaluation fixture validity (mocked CI)",()=>{
  it("covers varied phrasings across every domain, dates, multilingual and follow-up intents",()=>{
    expect(cases.length).toBeGreaterThan(24);
    expect(new Set(cases.flatMap(x=>x.expectedTools)).size).toBe(8);
    const registered: Set<string> = new Set(SUPERVISOR_FUNCTIONS.map(t=>t.name));
    for(const example of cases) {
      expect(example.question.trim().length).toBeGreaterThan(0);
      expect(example.expectedTools.length).toBeGreaterThan(0);
      for(const family of example.expectedTools) expect(registered.has(family)).toBe(true);
      expect(example.evidenceClass).toMatch(/verified|partial|estimated|unavailable/);
      expect(example.responseType).toBeTruthy();
    }
  });
});
