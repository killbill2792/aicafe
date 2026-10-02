import { describe, expect, it } from "vitest";
import { renamedProductSizes } from "./productNaming";

describe("grouped product rename", () => {
  it("renames every sibling size while preserving stable size labels", () => {
    expect(renamedProductSizes([
      { id: "16", sizeLabel: "16 oz" }, { id: "20", sizeLabel: "20 oz" }, { id: "24", sizeLabel: "24 oz" },
    ], "Americano")).toEqual([
      { id: "16", sizeLabel: "16 oz", baseName: "Americano", name: "Americano 16 oz" },
      { id: "20", sizeLabel: "20 oz", baseName: "Americano", name: "Americano 20 oz" },
      { id: "24", sizeLabel: "24 oz", baseName: "Americano", name: "Americano 24 oz" },
    ]);
  });
});
