import * as Sentry from "@sentry/nextjs";

// Gated behind NEXT_PUBLIC_SENTRY_DSN — see sentry.server.config.ts. Public because client-side
// code needs it in the browser bundle; it is not a secret (it only accepts events, never reads them).
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
});
