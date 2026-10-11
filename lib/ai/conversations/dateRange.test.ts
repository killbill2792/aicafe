import { describe, expect, it } from "vitest";
import { resolveCafeDateRange } from "./dateRange";
const ask = (period: Parameters<typeof resolveCafeDateRange>[0]["period"], asOf="2026-10-10") =>
  resolveCafeDateRange({period,from:null,to:null},asOf);
describe("Café-local calendar range resolver", () => {
  it("resolves exact calendar weeks and month boundaries",()=>{
    expect(ask("today")).toEqual({from:"2026-10-10",to:"2026-10-10"});
    expect(ask("yesterday")).toEqual({from:"2026-10-09",to:"2026-10-09"});
    expect(ask("week_to_date")).toEqual({from:"2026-10-05",to:"2026-10-10"});
    expect(ask("previous_week")).toEqual({from:"2026-09-28",to:"2026-10-04"});
    expect(ask("previous_month")).toEqual({from:"2026-09-01",to:"2026-09-30"});
    expect(ask("last_7_days")).toEqual({from:"2026-10-04",to:"2026-10-10"});
    expect(ask("last_28_days")).toEqual({from:"2026-09-13",to:"2026-10-10"});
  });
  it("validates explicit date ranges and refuses guessed future/oversized periods",()=>{
    expect(resolveCafeDateRange({period:"custom",from:"2026-07-01",to:"2026-07-31"},"2026-10-10"))
      .toEqual({from:"2026-07-01",to:"2026-07-31"});
    expect(()=>resolveCafeDateRange({period:"custom",from:"2026-13-01",to:"2026-09-30"},"2026-10-10")).toThrow();
    expect(()=>resolveCafeDateRange({period:"custom",from:"2026-10-09",to:"2026-10-12"},"2026-10-10")).toThrow();
  });
});
