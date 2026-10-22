import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";
import { PANTRY_STARTERS, displayPantryStarterName } from "./pantryStarter";

const catalogs = { en, es, ar };
function translate(locale: "en" | "es" | "ar", key: string): string {
  const t = createTranslator({locale, messages: catalogs[locale]});
  return t(`Pantry.starters.${key}` as never);
}
describe("localized pantry names", () => {
  it("provides a label for every starter in all three owner locales", () => {
    for (const ingredient of PANTRY_STARTERS) {
      for (const locale of ["en", "es", "ar"] as const) {
        const label = translate(locale, ingredient.key);
        expect(label.length).toBeGreaterThan(1);
        expect(label).not.toContain("Pantry.starters");
      }
    }
  });
  it("renders starter defaults in the current language without changing stable keys", () => {
    expect(displayPantryStarterName("Whole milk", "milk-whole", (k) => translate("es",k))).toBe("Leche entera");
    expect(displayPantryStarterName("Whole milk", "milk-whole", (k) => translate("ar",k))).toBe("حليب كامل الدسم");
  });
  it("never replaces an owner-customized name with a translated default", () => {
    const t = (k: string) => translate("ar",k);
    expect(displayPantryStarterName("Neighborhood oat", "milk-oat", t)).toBe("Neighborhood oat");
    expect(displayPantryStarterName("My special milk", null, t)).toBe("My special milk");
  });
});
