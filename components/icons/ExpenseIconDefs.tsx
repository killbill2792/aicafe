/**
 * Shared SVG symbol sprite for every expense/money icon in the app (docs/02-design-system.md
 * "Expense icons" table). Render <ExpenseIconDefs /> once near the root (see layout.tsx);
 * everything else references a symbol by id via <use>, so every screen draws the same shapes.
 * Rent/electricity/insurance/loan/software/supplies/cup silhouettes are adapted from
 * design/mockups/cost-recovery.html; the rest follow the same rounded-silhouette style.
 */
export default function ExpenseIconDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="ic-rent" viewBox="0 0 48 48">
          <path d="M6 44V16L24 5l18 11v28z" />
          <g style={{ fill: "var(--detail, #fff)" }}>
            <rect x="12" y="19" width="7" height="6" rx="1.5" />
            <rect x="29" y="19" width="7" height="6" rx="1.5" />
            <rect x="12" y="29" width="7" height="6" rx="1.5" />
            <rect x="29" y="29" width="7" height="6" rx="1.5" />
            <path d="M20 44V33a4 4 0 0 1 8 0v11z" />
          </g>
        </symbol>

        <symbol id="ic-utilities_power" viewBox="0 0 48 48">
          <path d="M24 3a15 15 0 0 0-9 27v6h18v-6A15 15 0 0 0 24 3z" />
          <rect x="16" y="38" width="16" height="6" rx="2" />
          <path style={{ fill: "var(--detail, #fff)" }} d="M26 9l-9 13h6l-2 10 9-13h-6z" />
        </symbol>

        <symbol id="ic-water" viewBox="0 0 48 48">
          <path d="M24 4c8 10 16 19.5 16 27.5A16 16 0 0 1 8 31.5C8 23.5 16 14 24 4z" />
          <path
            style={{ fill: "none", stroke: "var(--detail, #fff)", strokeWidth: 3, strokeLinecap: "round" }}
            d="M16 30a8 8 0 0 0 8 8"
          />
        </symbol>

        <symbol id="ic-internet" viewBox="0 0 48 48">
          <circle cx="24" cy="38" r="4.5" />
          <path
            style={{ fill: "none", stroke: "currentColor", strokeWidth: 5, strokeLinecap: "round" }}
            d="M13 27a15.5 15.5 0 0 1 22 0"
          />
          <path
            style={{ fill: "none", stroke: "currentColor", strokeWidth: 5, strokeLinecap: "round" }}
            d="M5 18a27 27 0 0 1 38 0"
          />
        </symbol>

        <symbol id="ic-insurance" viewBox="0 0 48 48">
          <path d="M24 3l17 6v13c0 11.5-7.4 19.6-17 23-9.6-3.4-17-11.5-17-23V9z" />
          <path
            style={{ fill: "none", stroke: "var(--detail, #fff)", strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" }}
            d="M16 24l6 6 11-12"
          />
        </symbol>

        <symbol id="ic-loan" viewBox="0 0 48 48">
          <path d="M3 17L24 5l21 12z" />
          <rect x="7" y="20" width="6" height="16" />
          <rect x="17" y="20" width="6" height="16" />
          <rect x="25" y="20" width="6" height="16" />
          <rect x="35" y="20" width="6" height="16" />
          <rect x="3" y="38" width="42" height="6" rx="1.5" />
        </symbol>

        <symbol id="ic-software" viewBox="0 0 48 48">
          <path d="M14 3h20a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z" />
          <g style={{ fill: "var(--detail, #fff)" }}>
            <rect x="15" y="10" width="7" height="7" rx="2" />
            <rect x="26" y="10" width="7" height="7" rx="2" />
            <rect x="15" y="21" width="7" height="7" rx="2" />
            <rect x="26" y="21" width="7" height="7" rx="2" />
            <rect x="20" y="37" width="8" height="3" rx="1.5" />
          </g>
        </symbol>

        <symbol id="ic-supplies" viewBox="0 0 48 48">
          <path d="M9 16h30l-3 28H12z" />
          <path
            style={{ fill: "none", stroke: "var(--sil, #2A1D14)", strokeWidth: 4, strokeLinecap: "round" }}
            d="M17 18v-5a7 7 0 0 1 14 0v5"
          />
        </symbol>

        <symbol id="ic-repairs" viewBox="0 0 48 48">
          <path d="M31 6a11 11 0 0 0-14.8 13L6 29.2 12.8 36l10.2-10.2A11 11 0 0 0 36 12.2l-7 7-4.2-4.2 7-7z" />
        </symbol>

        <symbol id="ic-other" viewBox="0 0 48 48">
          <path d="M6 8a2 2 0 0 1 2-2h16l16 16-20 20L4 26V10z" />
          <circle cx="16" cy="16" r="3.5" style={{ fill: "var(--detail, #fff)" }} />
        </symbol>

        <symbol id="ic-ingredients" viewBox="0 0 48 48">
          <path d="M8 16h26v12a10 10 0 0 1-10 10h-6a10 10 0 0 1-10-10z" />
          <path
            style={{ fill: "none", stroke: "var(--sil, #2A1D14)", strokeWidth: 4, strokeLinecap: "round" }}
            d="M34 20h4a4 4 0 0 1 0 8h-4"
          />
          <path
            style={{ fill: "none", stroke: "var(--sil, #2A1D14)", strokeWidth: 3, strokeLinecap: "round" }}
            d="M16 10c0-2 2-2 2-4M24 10c0-2 2-2 2-4"
          />
        </symbol>

        <symbol id="ic-milk" viewBox="0 0 48 48">
          <path d="M17 4h14l2 8-3 3v25a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3V15l-3-3z" />
          <rect x="14" y="24" width="20" height="7" style={{ fill: "var(--detail, #fff)" }} />
        </symbol>

        <symbol id="ic-card" viewBox="0 0 48 48">
          <rect x="4" y="10" width="40" height="28" rx="5" />
          <rect x="4" y="17" width="40" height="6" style={{ fill: "var(--detail, #fff)" }} />
          <rect x="10" y="29" width="12" height="4" rx="2" style={{ fill: "var(--detail, #fff)" }} />
        </symbol>

        <symbol id="ic-staff" viewBox="0 0 48 48">
          <circle cx="24" cy="15" r="9" />
          <path d="M6 43c0-9 8-14 18-14s18 5 18 14z" />
        </symbol>

        <symbol id="ic-payroll_tax" viewBox="0 0 48 48">
          <circle cx="19" cy="13" r="7.5" />
          <path d="M4 43c0-7.5 6.5-11.5 15-11.5S34 35.5 34 43z" />
          <rect x="30" y="20" width="15" height="19" rx="2" style={{ fill: "var(--sil, #2A1D14)" }} />
          <g style={{ fill: "var(--detail, #fff)" }}>
            <rect x="33" y="24" width="9" height="2.4" />
            <rect x="33" y="29" width="9" height="2.4" />
            <rect x="33" y="34" width="6" height="2.4" />
          </g>
        </symbol>

        <symbol id="ic-profit" viewBox="0 0 48 48">
          <ellipse cx="24" cy="12" rx="15" ry="6" />
          <path d="M9 12v10c0 3.3 6.7 6 15 6s15-2.7 15-6V12" />
          <path d="M9 22v10c0 3.3 6.7 6 15 6s15-2.7 15-6V22" />
          <path d="M9 32v4c0 3.3 6.7 6 15 6s15-2.7 15-6v-4" />
        </symbol>

        <symbol id="ic-cup" viewBox="0 0 24 24">
          <path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
          <path style={{ fill: "none", stroke: "var(--sil, #2A1D14)", strokeWidth: 2.2 }} d="M17 10h1.5a2 2 0 0 1 0 4H17" />
        </symbol>

        <symbol id="ic-check" viewBox="0 0 24 24">
          <path
            style={{ fill: "none", stroke: "#fff", strokeWidth: 3.4, strokeLinecap: "round", strokeLinejoin: "round" }}
            d="M5 12l5 5 9-10"
          />
        </symbol>
      </defs>
    </svg>
  );
}

export const EXPENSE_ICON_CODES = [
  "rent",
  "utilities_power",
  "water",
  "internet",
  "insurance",
  "loan",
  "software",
  "supplies",
  "repairs",
  "other",
  "ingredients",
  "milk",
  "card",
  "staff",
  "payroll_tax",
  "profit",
] as const;

export type ExpenseIconCode = (typeof EXPENSE_ICON_CODES)[number];
