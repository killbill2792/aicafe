import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["en", "es", "ar"],
  defaultLocale: "en",
});

export const rtlLocales: readonly string[] = ["ar"];

export function getDirection(locale: string): "ltr" | "rtl" {
  return rtlLocales.includes(locale) ? "rtl" : "ltr";
}
