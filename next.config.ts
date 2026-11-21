import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // @supabase/pg-parser 0.1.7 loads the PG17 WASM binary from the filesystem.
  // Next.js cannot statically trace the dynamic load, so include the real asset
  // in Node server traces (cron, owner chat and future callers) on Vercel.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@supabase/pg-parser/wasm/17/pg-parser.wasm"],
  },
  // Default Server Action body limit is 1MB. A labor CSV import sends up to MAX_LABOR_ROWS
  // (10,000) full shift rows in one call (lib/actions/csvImport.ts) — real-world Toast time-entry
  // exports are far smaller, but a large file must fail with this import's own clear row-limit
  // error, not an opaque body-size rejection before the action even runs.
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

export default withNextIntl(nextConfig);
