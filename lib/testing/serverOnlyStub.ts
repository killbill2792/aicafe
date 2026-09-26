// Vitest alias target for the "server-only" package (vitest.config.ts) — under plain Node/Vitest
// (no Next.js webpack build), the real package always throws. Tests run server code directly, so
// the safety guard (which only matters for accidental client-bundle inclusion) is a no-op here.
export {};
