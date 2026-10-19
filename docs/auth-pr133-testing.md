# PR #133 — Authentication preview and email configuration

This PR changes only AI Café authentication behavior. Do not merge or deploy until the checks below pass in an isolated sandbox.

## Preview setup
- Confirm the Vercel **Preview** environment points to an isolated Supabase project with the AI Café schema/RLS, not production.
- Configure Preview values for NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and server-only SUPABASE_SERVICE_ROLE_KEY. Never expose service-role credentials to a browser.
- Enable the Email provider and email confirmations in the sandbox Supabase Auth settings. Configure email delivery (SMTP) for real testing.
- Under **Authentication → URL Configuration**, add the **exact** preview callback URL pattern `https://<your-preview-domain>/auth/callback**` (or a narrowly scoped Vercel deployment wildcard approved for your team). A single `*` does not match `/` in path/query components. Prefer exact callback URLs for production. Keep Site URL set to the appropriate default site.

## Email templates required for cross-device support
The existing code-based links still work when the email is opened in the initiating browser.
For email-opened-on-another-device support, set the three Supabase email templates (sandbox first!) to link to the callback with the hash. The `{{ .RedirectTo }}` value comes from the request and includes `/auth/callback?locale=...&flow=...`, so it preserves the preview host and selected language.

Confirm signup:
```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=signup">Confirm your account</a>
```
Reset password:
```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
```
Magic link:
```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Sign in</a>
```

Review the template preview and verify actual redirect destinations before enabling production use. Keep the query string URL encoding valid in rendered HTML. The callback validates verification type and locale, exchanges tokens server-side and restricts destinations to approved pages.

## Required sandbox manual tests
1. Owner signs up with a new email; account confirmation arrives and lands on onboarding; café name is saved.
2. Repeat confirmation by opening the email link on a second browser/device; token-hash template succeeds.
3. Sign in with email and password, sign out from More, and verify protected pages redirect to login.
4. Confirm the signed-out account stays signed in on a second device (logout has local scope).
5. Request a password reset, use email link, save a new password; ensure old password no longer works and new one does.
6. Verify expired/corrupt links show a retryable error on Login, not a silent redirect.
7. Verify existing magic-link sign-in; test en/es/ar pages and ensure app navigation is hidden during auth.
8. Test two separate owners' café access/RLS; confirm other features remain unchanged.
9. Confirm no preview user or café data is written into production Supabase.

**No Supabase dashboard configuration changes are performed by this PR.**
