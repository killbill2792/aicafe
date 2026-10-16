import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
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
