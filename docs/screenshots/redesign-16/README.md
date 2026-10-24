# Redesign 16 — before/after visual evidence

This directory contains eight screenshots for the draft PR **Redesign 16: Cleanup** (#182).
GitHub Actions ran both the PR base and the cleanup branch in separate local-only
Next.js development servers. The `/staff` page uses the checked-in, deterministic
`STAFF_VISUAL_FIXTURES=true` fixture; `/more` uses the unauthenticated local
view. No shared or production database or credentials are connected.

| Route | Viewport | Before | After |
| --- | --- | --- | --- |
| `/en/staff?fixture=1&week=2026-10-26` | 390×844 | `before-staff-mobile.png` | `after-staff-mobile.png` |
| `/en/staff?fixture=1&week=2026-10-26` | 1440×900 | `before-staff-desktop.png` | `after-staff-desktop.png` |
| `/en/more` | 390×844 | `before-more-mobile.png` | `after-more-mobile.png` |
| `/en/more` | 1440×900 | `before-more-desktop.png` | `after-more-desktop.png` |

All four before/after pairs were verified to be **byte-for-byte identical**.
The snapshot script suppresses only Next.js's *development-only* status overlay
(`nextjs-portal`), which otherwise animates asynchronously and is not part of
the café application. Other UI content is not masked.

Reproduction: `.github/workflows/redesign16-visual.yml` executes
`scripts/redesign16-visual-compare.mjs`, checks PNG byte equality, and commits
the resulting evidence. The workflow explicitly clears Supabase environment
variables and runs only against local loopback servers.
