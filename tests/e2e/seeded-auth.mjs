import {expect} from "@playwright/test";
import {TEST_CAFES} from "../../scripts/seed/cafes.mjs";

const loopback = "127.0.0.1";
const localNext = "http://127.0.0.1:3000";
const localSupabase = "http://127.0.0.1:54321";

// This helper is evaluated before launching ANY authenticated journey. A
// workflow misconfiguration must fail rather than visit a real café account.
export function assertDisposableEnvironment() {
  for (const value of [
    process.env.PLAYWRIGHT_BASE_URL ?? localNext,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ]) {
    if (!value) throw new Error("E2 requires local Supabase and Next.js URLs");
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.hostname !== loopback)
      throw new Error("E2 refuses non-loopback browser/auth endpoint");
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== localSupabase ||
      !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    throw new Error("E2 requires the actual local Supabase anon key");
  // A nonfunctional local E2 sentinel permits testing the authenticated file
  // picker without a paid model. A real model key is still categorically denied.
  if ((process.env.OPENAI_API_KEY ?? "") !== "aicafe-disposable-e2e-no-provider" ||
      process.env.VERCEL_URL)
    throw new Error("E2 requires the nonfunctional provider sentinel and no previews");
}

export function seededCafe(index) {
  const cafe = TEST_CAFES[index];
  if (!cafe?.businessId || !cafe.owner?.email || !cafe.owner.password ||
      !cafe.owner.userId || !cafe.name || !cafe.currency || !cafe.timezone)
    throw new Error("Incomplete generated two-café E2 seed");
  return cafe;
}

export async function login(page, cafe) {
  assertDisposableEnvironment();
  await page.goto("/en/login");
  await expect(page.locator("#email")).toBeVisible();
  await page.locator("#email").fill(cafe.owner.email);
  await page.locator("#login-password").fill(cafe.owner.password);
  await page.locator("form button[type=submit]").click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, {timeout: 30_000});
  await expect(page.getByText(cafe.name, {exact: true}).first())
    .toBeVisible({timeout: 30_000});
}

export async function openOwnedPage(page, cafe, pathname) {
  await page.goto("/en/" + pathname);
  await expect(page).not.toHaveURL(/\/login(?:\?|$)|\/onboarding(?:\?|$)/);
  await expect(page.getByText(cafe.name, {exact: true}).first())
    .toBeVisible({timeout: 30_000});
}
