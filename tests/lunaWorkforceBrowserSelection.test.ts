import { expect, it } from "vitest";
import { classifyPaths } from "../scripts/e2e/targeted.mjs";

it("requires the signed-in owner journey for each workforce profile surface", () => {
  const paths = ["app/[locale]/operations/team/page.tsx", "components/luna/WorkforceProfileForm.tsx"];
  for (const path of paths) {
    expect(classifyPaths([path])).toEqual({ scenarios: ["home"], unmapped: [], required: true });
  }
});

it("continues to reject unknown Luna browser surfaces", () => {
  const unknown = "components/luna/UnregisteredSurface.tsx";
  expect(classifyPaths([unknown])).toEqual({ scenarios: [], unmapped: [unknown], required: true });
});
