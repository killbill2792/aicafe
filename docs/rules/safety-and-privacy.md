## 8. Safety and privacy (non-negotiable)
1. Each café sees only its own data. **RLS is enabled on every table**, with a CI check that fails if any
   `public` table has RLS off. Views use `security_invoker=true` or are service-role only.
2. Service-role keys only on the server, never in client components.
3. The model never writes SQL, never sees other cafés, never writes to the POS.
4. **Every action is logged:** who asked, what was proposed, who approved, what happened, when.
5. Never log tokens, bank lines, receipts, prompts with personal data, or API keys.
6. Never ask for bank or POS passwords. OAuth or owner-downloaded files only. Encrypt POS tokens at rest.
7. New owner-facing strings go in `messages/en.json` only for now. Do not add or update Spanish or Arabic strings or translation logic; preserve existing strings. Never fall back to an unrelated key.
8. Accessibility: WCAG AA, 48px targets, 17px minimum body text, reduced motion. `docs/02-design-system.md`
   is binding for UI.
9. Progressive disclosure: answer first, details behind an intentional tap. Never show internal enums,
   model names, token counts or cost telemetry to owners.
