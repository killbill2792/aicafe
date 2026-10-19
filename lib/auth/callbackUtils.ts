/** Keep callback redirects same-origin, locale-scoped and limited to known auth destinations. */
export type AuthLocale = "en" | "es" | "ar";
export type AuthFlow = "signup" | "recovery" | "magic";
export type AuthTokenType = "signup" | "recovery" | "email";

export function authLocale(value: string | null): AuthLocale {
  return value === "es" || value === "ar" ? value : "en";
}

export function authFlow(value: string | null): AuthFlow {
  return value === "signup" || value === "recovery" ? value : "magic";
}

export function authDestination(locale: AuthLocale, flow: AuthFlow): string {
  if (flow === "signup") return `/${locale}/onboarding`;
  if (flow === "recovery") return `/${locale}/reset-password`;
  return `/${locale}`;
}

/** Compatibility for pre-existing code-based callback links with a 'next' argument. */
export function safeCallbackDestination(locale: AuthLocale, candidate: string | null, flow: AuthFlow): string {
  if (!candidate) return authDestination(locale, flow);
  const allowed = [`/${locale}`, `/${locale}/onboarding`, `/${locale}/reset-password`];
  return allowed.includes(candidate) ? candidate : authDestination(locale, flow);
}

export function authTokenType(value: string | null): AuthTokenType | null {
  return value === "signup" || value === "recovery" || value === "email" ? value : null;
}

export function tokenDestination(locale: AuthLocale, type: AuthTokenType): string {
  return authDestination(locale, type === "signup" ? "signup" : type === "recovery" ? "recovery" : "magic");
}
