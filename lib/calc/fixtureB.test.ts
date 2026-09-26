import { describe, expect, it } from "vitest";
import { roundHalfUpToCent } from "./money";
import { cardFeePerDrinkCents, extraMoneyFromOneMoreDrinkCents, staffCostPerPrepSecond, staffTimePerDrinkCents } from "./perDrink";
import { FIXTURE_B } from "./__fixtures__/fixtureB";

describe("Fixture B: per-drink staff time", () => {
  const totalPrepSeconds =
    FIXTURE_B.latte.prepSeconds * FIXTURE_B.latte.quantity + FIXTURE_B.drip.prepSeconds * FIXTURE_B.drip.quantity;

  it("staff cost per prep-second is $0.025", () => {
    const perSecond = staffCostPerPrepSecond(FIXTURE_B.loadedStaffCostCents, totalPrepSeconds);
    expect(perSecond).toBeCloseTo(2.5, 6); // cents/sec
  });

  it("latte staff time is $2.25, drip is $0.75", () => {
    const perSecond = staffCostPerPrepSecond(FIXTURE_B.loadedStaffCostCents, totalPrepSeconds);
    expect(roundHalfUpToCent(staffTimePerDrinkCents(FIXTURE_B.latte.prepSeconds, perSecond))).toBe(225);
    expect(roundHalfUpToCent(staffTimePerDrinkCents(FIXTURE_B.drip.prepSeconds, perSecond))).toBe(75);
  });

  it("latte: card fee $0.1531, extra money from one more latte rounds to $1.90", () => {
    const perSecond = staffCostPerPrepSecond(FIXTURE_B.loadedStaffCostCents, totalPrepSeconds);
    const staffTime = staffTimePerDrinkCents(FIXTURE_B.latte.prepSeconds, perSecond);
    const cardFee = cardFeePerDrinkCents(FIXTURE_B.latte.priceCents, FIXTURE_B.effectiveFeeRate);
    expect(cardFee).toBeCloseTo(15.3125, 3);

    const extraMoney = extraMoneyFromOneMoreDrinkCents(
      FIXTURE_B.latte.priceCents,
      FIXTURE_B.latte.ingredientsCents,
      cardFee,
      staffTime,
    );
    expect(roundHalfUpToCent(extraMoney)).toBe(190);
  });
});
