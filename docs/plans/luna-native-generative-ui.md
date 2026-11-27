# Luna native generative UI — upstream package integration

Goal: one native JSON Render catalog and renderer, not a copied set of selected widgets. PR #586 is stacked on #585 and must not merge before full CI, browser verification and review.

- Import the entire installed `@json-render/shadcn/catalog` definition export and matching `@json-render/shadcn` implementation export. Build the model prompt from those definitions. There is no hand-maintained component-name list.
- Preserve native specs including state, local events, visibility, bindings, templates, computed values, repeat, named slots and acyclic local watchers through the existing streamed and stored rich-presentation block. The state belongs to each message, not the app or business database.
- Retain existing financial `DataView` charts, tables, authenticated attachments, calculators and historic stored presentations. Resolve scoped snapshots server-side; pass them opaquely into the native composition. Add state-bound LunaChart and exact calculator/format computed functions so sliders and forms can update arbitrary financial analyses without a provider call.
- Use upstream security-compatible local state actions only. No arbitrary client scripts, new endpoint or unauthenticated network action. Images from model specs are embedded safe raster data or authenticated attachment controls, not auto-fetches of arbitrary URLs. User-initiated HTTPS links are permitted. Reject prototype paths and action cycles; preserve valid legacy leaves and answer text when a spec is invalid.
- Tailwind 4 is required by the installed upstream shadcn package; use the existing theme tokens and compatibility config. Browser coverage of existing screens and native interactions is required before merging.
- Dependabot proposes grouped updates for all `@json-render/*` packages weekly. Lockfile is checked in, versions must remain aligned, and catalog/registry parity tests discover every installed component automatically. Compatible additions need no manually authored component entry. Breaking changes, security review, browser compatibility and removal of old component types still require review; never auto-deploy unreviewed npm releases.
- No real Luna acceptance run or production deployment is required for deterministic tests; use the normal seeded browser and database suites.

## Accounting presentation delivery

The official Table renders display strings. Numeric, boolean, null and state-bound scalar cells are normalized to readable strings without changing their numeric meaning; null is explicitly unknown. No manually copied widget implementation. If an incompatible resolved prop cannot be rendered, show an explicit technical notice rather than a blank component; preserve valid sibling content. Browser and unit regressions cover the mixed accounting ledger. This does not alter evidence confidence or permit new effects.
