import "server-only";

/**
 * Square OAuth (docs/06-integrations.md "Square (v1, OAuth, read-only)"). Uses sandbox or
 * production hosts based on SQUARE_ENVIRONMENT. Scopes are read-only, per CLAUDE.md rule 5 —
 * never request write scopes.
 */
const SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ORDERS_READ",
  "PAYMENTS_READ",
  "ITEMS_READ",
  "EMPLOYEES_READ",
  "TIMECARDS_READ",
  "TIMECARDS_SETTINGS_READ",
];

function isSandbox() {
  return (process.env.SQUARE_ENVIRONMENT ?? "sandbox") !== "production";
}

export function squareApiBaseUrl(): string {
  return isSandbox() ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

function squareWebBaseUrl(): string {
  return isSandbox() ? "https://squareupsandbox.com" : "https://squareup.com";
}

export function isSquareConfigured(): boolean {
  return Boolean(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_APPLICATION_SECRET);
}

/** Step 1: send the owner here (docs/03-screens.md S2 step 1, "Connect Square"). */
export function buildAuthorizeUrl(state: string): string {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const redirectUri = process.env.SQUARE_REDIRECT_URI;
  if (!applicationId || !redirectUri) throw new Error("Missing SQUARE_APPLICATION_ID or SQUARE_REDIRECT_URI");

  const params = new URLSearchParams({
    client_id: applicationId,
    scope: SCOPES.join(" "),
    session: "false",
    state,
    redirect_uri: redirectUri,
  });
  return `${squareWebBaseUrl()}/oauth2/authorize?${params.toString()}`;
}

export type SquareTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  merchant_id: string;
};

export async function exchangeCodeForToken(code: string): Promise<SquareTokenResponse> {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET;
  const redirectUri = process.env.SQUARE_REDIRECT_URI;
  if (!applicationId || !applicationSecret || !redirectUri) throw new Error("Square OAuth is not configured");

  const res = await fetch(`${squareApiBaseUrl()}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "Square-Version": "2025-05-21" },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Square token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<SquareTokenResponse> {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET;
  if (!applicationId || !applicationSecret) throw new Error("Square OAuth is not configured");

  const res = await fetch(`${squareApiBaseUrl()}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "Square-Version": "2025-05-21" },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Square token refresh failed (${res.status}): ${await res.text()}`);
  return res.json();
}
