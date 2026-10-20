import {describe,expect,it} from "vitest";
import {priceExperimentFollowupIntent,normalizedDrinkName} from "./priceIntent";
describe("registered owner follow-up intent",()=>{
  it("recognizes explicit intent after a specific price scenario",()=>{
    expect(priceExperimentFollowupIntent("Let's try it.",
      "What's the impact if I raise the latte price by 10 cents?"))
      .toEqual({product:"latte",increaseCents:10});
    expect(priceExperimentFollowupIntent("Let's try it",
      "Increase the price of 12oz latte by 15 cents"))
      .toEqual({product:"12oz latte",increaseCents:15});
  });
  it("never turns discussion or ambiguous scenarios into owner consent",()=>{
    expect(priceExperimentFollowupIntent("What if we try it?",
      "Raise the latte price by 10 cents")).toBeNull();
    expect(priceExperimentFollowupIntent("Don't try it",
      "Raise the latte price by 10 cents")).toBeNull();
    expect(priceExperimentFollowupIntent("Let's try it",
      "Raise the latte price by 10 cents or raise it by 20 cents")).toBeNull();
    expect(priceExperimentFollowupIntent("Let's try it",
      "Raise latte price by 0 cents")).toBeNull();
    expect(priceExperimentFollowupIntent("Let's try it",
      "Publish everyone's shifts")).toBeNull();
  });
  it("normalizes size-specific drink identities but not their meaning",()=>{
    expect(normalizedDrinkName("Latte · 12 OZ")).toBe("latte 12 oz");
    expect(normalizedDrinkName("Latte · 16 OZ")).not.toBe("latte 12 oz");
  });
});
