import type { Config } from "tailwindcss";

// Tokens copied from docs/02-design-system.md — keep this file in sync with that doc.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#2A1D14",
        "ink-muted": "#6B5B4E",
        paper: "#F6F1E9",
        card: "#FFFFFF",
        line: "#E6DCCD",
        good: "#1E6B4B",
        "good-tint": "#E3F0E8",
        warn: "#B4460E",
        "warn-tint": "#FBE9DC",
        staff: "#2F5D8A",
        ingredients: "#8B5A2B",
        running: "#E0AE4E",
        fees: "#A7B0BA",
      },
      fontFamily: {
        headline: ["var(--font-fraunces)", "Georgia", "serif"],
        body: ["var(--font-figtree)", "system-ui", "sans-serif"],
        arabic: ["var(--font-ibm-plex-arabic)", "system-ui", "sans-serif"],
      },
      fontSize: {
        "money-lg": ["80px", { lineHeight: "1.1" }],
        "money-md": ["56px", { lineHeight: "1.1" }],
        "money-sm": ["44px", { lineHeight: "1.15" }],
      },
      borderRadius: {
        card: "20px",
        "card-lg": "24px",
      },
      maxWidth: {
        app: "480px",
      },
    },
  },
  plugins: [],
};

export default config;
