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

## Color tokens
| Token | Hex | Use |
|---|---|---|
| `ink` | #2A1D14 | Main text, primary buttons |
| `ink-muted` | #6B5B4E | Secondary text (passes AA on `paper` and white) |
| `paper` | #F6F1E9 | App background |
| `card` | #FFFFFF | Cards |
| `line` | #E6DCCD | Dividers, borders |
| `good` | #1E6B4B | Profit, covered, positive change |
| `good-tint` | #E3F0E8 | Background behind good states |
| `warn` | #B4460E | Missing costs, leaks, negative change |
| `warn-tint` | #FBE9DC | Background behind warnings |
| `staff` | #2F5D8A | Staff cost color in charts |
| `ingredients` | #8B5A2B | Ingredient cost color in charts |
| `running` | #E0AE4E | Rent & bills color in charts |
| `fees` | #A7B0BA | Card fees color in charts |

Dark mode: not in v1. Café screens are used in bright light.

## Typography
- **Numbers and headlines:** Fraunces (600/700), fallback Georgia. Big money numbers are 44–80px.
- **Body and labels:** Figtree (400–800), fallback system sans.
- **Arabic:** IBM Plex Sans Arabic. Keep money in Western digits with `$` unless the owner switches in Settings.
- Minimum body size 17px. Secondary labels no smaller than 13px. Line height 1.4 for body.
- Sentence case everywhere. No ALL-CAPS labels in new screens (older mockups have a few; replace them with sentence case).

## Layout
- Mobile first, 360–430px wide. Single column, max content width 480px (`max-w-app`).
- Tablet/desktop: the app shell uses the available width instead of staying pinned to 480px.
  Ordinary single-column screens (Home, Money, Staff, More, every form) get a wider but still
  readable centered column, `max-w-app-content` (840px). The Menu list and product detail screens
  — the ones with enough content to actually use more space — get `max-w-app-wide` (1280px).
  Every screen's outer `<main>` gets this policy via the shared `components/shared/PageShell.tsx`
  wrapper rather than each page styling its own width. Forms stay comfortably narrow (e.g.
  `max-w-md`) even inside a wide shell — never stretch a form to the full shell width.
- Navigation: bottom tab bar on mobile (`components/TabBar.tsx`, below the `md` breakpoint), a
  fixed left sidebar on tablet/desktop (`components/SideNav.tsx`, `md:` and up) — the same 6
  primary destinations, shared via `components/shared/navTabs.ts`: **Home, AI Team, Money, Menu,
  Staff, More**. Mobile may use the shorter localized label **Team** for AI Team. "Add cost" is a large round button fixed above the tab bar on Home and
  Money (tucks closer to the bottom edge on desktop, since there's no bottom tab bar to clear).
- Card radius 20–24px, inner padding 16–20px, gap 14px between cards.
- Touch targets at least 48px tall. Primary buttons 56px.
- Numbers right-aligned in lists. Currency always shown ($).

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
