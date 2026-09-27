"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/** Catches an error in the root layout itself — no next-intl/locale context is guaranteed to be
 * available here, so this is the one screen in the app with hardcoded English text. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[global error]", error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F6F1E9", fontFamily: "system-ui, sans-serif", color: "#2A1D14" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong</h1>
          <p style={{ maxWidth: 320, color: "#6B5B4E" }}>Please try again. If this keeps happening, close and reopen the app.</p>
          <button
            type="button"
            onClick={reset}
            style={{ height: 56, borderRadius: 28, background: "#2A1D14", color: "#F6F1E9", border: "none", padding: "0 32px", fontSize: 16, fontWeight: 700 }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
