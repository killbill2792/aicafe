import * as Sentry from "@sentry/nextjs";

// Gated behind SENTRY_DSN so the app runs unchanged with zero Sentry account (see PROGRESS.md
// "Needs connecting"). When unset, Sentry.init with an empty dsn is a documented no-op.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
});
