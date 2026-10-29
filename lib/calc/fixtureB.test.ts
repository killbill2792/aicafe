import { describe, expect, it } from "vitest";
import { FIXTURE_B } from "./__fixtures__/fixtureB";

describe("Fixture B retained for canonical tests",()=>{
 it("retains the input values without duplicate per-drink formulas",()=>{
  expect(FIXTURE_B.latte.priceCents).toBeGreaterThan(0);
  expect(FIXTURE_B.latte.quantity).toBeGreaterThan(0);
 });
});
