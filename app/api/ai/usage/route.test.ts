import {describe,it,expect} from "vitest";
import {GET} from "./route";

describe("Legacy usage API no longer exposes owner-facing provider telemetry",()=>{
  it("does not return token, model or cost totals",async()=>{
    const response=await GET();
    expect(response.status).toBe(404);
    const body=await response.json();
    expect(body).toEqual({error:"not_found"});
    expect(JSON.stringify(body)).not.toMatch(/token|provider|model|cost|price|business/);
  });
});
