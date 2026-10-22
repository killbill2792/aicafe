# 02 — Design system (binding)

Approved visual references: `design/mockups/*.html`. Match their look. This doc explains the rules behind them.

## Design for everyone at once
Our users range from a 68-year-old owner who reads Arabic first to a 22-year-old shift manager. One design must work for both.
The way to do that: **show, then tell**. Every idea appears three ways at once, so nobody depends on just one:

1. **A picture** (an icon or illustration that fills, grows, or changes color)
2. **A big number** (in dollars, cups, or days, never percentages alone)
3. **A few plain words** ("Rent covered on the 7th")

Rules that follow from this:
- **Never icon-only.** Every icon has a word next to or under it.
- **Never color-only.** Good/bad is also shown by shape (✓, arrow direction) and by darkness, so it works for color-blind users and in bright café light.
- **Dollars and cups first, percentages second.** "$620" and "3,200 cups" are understood by everyone. "27%" goes underneath as a secondary label.
- **One idea per card.** If a card needs two sentences to explain, split it.
- **Simple by default, detail on tap.** The first screen is glanceable. Every number is tappable and leads to the rows behind it. Nothing is hidden, it's just one tap deeper.
- **Detail mode (Settings toggle, off by default):** shows extra columns and percentages for managers who want them. It never removes the pictures.

## The fill metaphor (signature visual)
Every expense has an **illustrated icon that fills with green from the bottom up** as this month's money pays it back.
- 0% covered: icon drawn in light outline over a pale fill.
- Partly covered: green rises inside the icon to the exact percentage, with the % and $ left shown beside it.
- 100% covered: fully green, with a white ✓ badge and "Covered on Sep 7".
- The fill animates **once**, when the screen opens or when new money arrives (600ms ease-out). Respect `prefers-reduced-motion`: show the final state without animation.

Use the same icons everywhere an expense appears (Overview, Profit, Cost recovery, cost per drink), so owners learn them once.

## Expense icons (consistent across the whole app)
| Expense | Icon | Notes |
|---|---|---|
| Rent | Building / storefront with door and windows | The hero of cost recovery; draw it larger |
| Electricity & gas | Lightning bolt inside a bulb | |
| Water | Water drop | |
| Internet & phone | Wi-Fi arcs | |
| Insurance | Shield with check | |
| Loan payment | Bank building with columns | |
| Software & subscriptions | Phone with app tiles | |
| Staff | Person (group of 2–3 for totals) | |
| Payroll taxes | Person with small receipt | |
| Ingredients & cups | Coffee cup with steam | |
| Milk | Milk carton | Used for ingredient price alerts |
| Card fees | Payment card | |
| Store runs & supplies | Shopping bag | |
| Repairs | Wrench | |
| Owner's profit | Coin stack or wallet, always green | |

Draw icons as simple, rounded, filled silhouettes (not thin line art). They must read at 40px. Use one consistent SVG set in `components/icons/`. Custom SVGs are fine; lucide-react can fill gaps.

## Semantic color system

Eight owner-selectable palettes: **Fresh Pour** (default), Night Roast, Market Green,
Berry Mocha, Blue Hour, Matcha, Caramel Sky and Cherry Cola. Light, Dark and System modes
are supported; System follows the OS preference. The default is Fresh Pour + System.
Theme tokens come from `app/themes.ts`; run `node scripts/build-themes.mjs` to regenerate
`app/themes.generated.css`. Colors are stored as space-separated RGB channels.

Semantic tokens: `bg`, `surface`, `surface2`, `line`, `fg`, `muted`,
`accent`, `accent-text`, `accent-soft`, `accent-2` (decorative),
`on-accent`, `pos`, `neg`, `warn-text`, `pos-soft`, `neg-soft`,
`warn-soft`, `nav`, `chart-*`, and `persona-*`.
Use `accent-text` for text links and selected labels; keep `accent` for fills.
Warnings are never color-only. Focus, body, and status text must pass AA contrast.

Deprecated aliases retained: `paper→bg`, `card→surface`, `ink→fg`,
`ink-muted→muted`, `good→pos`, `good-tint→pos-soft`,
`warn→warn-text`, `warn-tint→warn-soft`, and chart `staff`,
`ingredients`, `running`, `fees` → `chart-*`.

Shared UI building blocks in `components/ui/`: Card, Button/buttonClasses, Chip,
QuickReplies, Badge (including labelled unverified status), SectionHeader,
EmptyState and PersonaAvatar.

## Typography
- Headings/numbers: Plus Jakarta Sans (500–800).
- Body: Inter (400–700). Body minimum 17px.
- Arabic headings and body: IBM Plex Sans Arabic.
- Secondary labels at least 13px; no all-caps new labels.

## Layout
- Mobile first, 360–430px wide. Single column, max content width 480px (`max-w-app`).
- Tablet/desktop: the app shell uses the available width instead of staying pinned to 480px.
  Ordinary single-column screens (Money, Staff, More, every form) get a wider but still
  readable centered column, `max-w-app-content` (840px). The Supervisor-first Home, Menu list,
  and product detail screens have enough structured content to use `max-w-app-wide` (1280px).
  Every screen's outer `<main>` gets this policy via the shared `components/shared/PageShell.tsx`
  wrapper rather than each page styling its own width. Forms stay comfortably narrow (e.g.
  `max-w-md`) even inside a wide shell — never stretch a form to the full shell width.
- Navigation: bottom tab bar on mobile (`components/TabBar.tsx`, below the `md` breakpoint), a
  fixed left sidebar on tablet/desktop (`components/SideNav.tsx`, `md:` and up) — the same 5
  primary destinations, shared via `components/shared/navTabs.ts`: **Home, Money, Menu, Staff,
  More**. The AI Team remains available at `/operations` through the prominent **Team** button on
  Supervisor Home; owners do not have to choose a specialist before asking the Supervisor. "Add cost"
  is a large round button fixed above the tab bar on Home and Money (tucks closer to the bottom edge
  on desktop, since there's no bottom tab bar to clear).
- Card radius 20–24px, inner padding 16–20px, gap 14px between cards.
- Touch targets at least 48px tall. Primary buttons 56px.
- Numbers right-aligned in lists. Currency always shown ($).

## Supervisor AI caveats (low emphasis)

A caveat about AI-sourced information in the Supervisor chat is **inline supporting text**, not a high-stakes alert. Use `text-ink-muted` (#6B5B4E) on the chat's light surface, at **17px minimum** with body line-height at least 1.4; it passes WCAG AA contrast. A small decorative alert/info icon may precede the text, but do not add a border, filled tint, card, or boxed warning. Preserve the text itself and readable focus/RTL behavior. This is **not** the `warn-tint` missing-expense-category banner, which retains its own higher-emphasis pattern below.

## Words (plain language glossary)
Never show the left column to users. Use the right column.

| Don't say | Say |
|---|---|
| COGS, cost of goods | Ingredients & cups |
| Labor, labor cost | Staff cost |
| Net profit, EBITDA | Money you kept / Owner profit |
| Fixed costs, overhead, opex | Rent & bills |
| Prime cost | Ingredients + staff |
| Contribution margin | Extra money from one more drink |
| Variance | Difference from your recipe |
| Allocation | Share of rent & bills |
| Break-even point | Drinks needed to cover everything |
| Transactions | Orders |
| Sync failed | We couldn't get today's sales from Square. Tap to reconnect. |

Tone: calm, direct, respectful. Never blame staff; for voids say "worth a calm look, could be training".
Errors say what happened and what to do. Empty states invite action ("Add your rent to see when it's covered").

## Estimates and trust
- Any number built on an estimate shows an "Estimate" pill. Tapping it explains in one sentence and offers "Enter actual".
- If an expense category has nothing this month, show a warn-tint banner: "Water bill not added yet. Add".
- Show a small completeness line on Profit: "Costs entered: 7 of 9 this month".

## Languages
- `en`, `es`, `ar`. Language switch on the first onboarding screen and always in the header.
- Arabic uses `dir="rtl"`. Use logical CSS properties (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`) everywhere so RTL works without special cases. Mirror directional icons (back arrows, chevrons), never mirror numbers or the fill direction (fill always rises bottom-up).
- Machine-translate first, then have a native speaker review before showing owners.

## Accessibility checklist (every screen)
- WCAG AA contrast. Visible focus ring (2px `ink` outline, 2px offset).
- All icons have `aria-label` or are paired with visible text.
- Charts have a text summary for screen readers ("Rent 100% covered, utilities 100%, insurance 60%").
- Supports system text size up to 200% without horizontal scrolling.
- `prefers-reduced-motion` disables fill and number count-up animations.
