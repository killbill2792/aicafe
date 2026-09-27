import * as Sentry from "@sentry/nextjs";

// Gated behind SENTRY_DSN — see sentry.server.config.ts.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
});
