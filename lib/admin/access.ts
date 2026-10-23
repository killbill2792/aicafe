/** Intentionally fail closed: no ADMIN_EMAILS means no admins. */
export function isAdminEmail(email: string | null | undefined, allowlist: string | null | undefined): boolean {
  if (!email || !allowlist) return false;
  const normalized = email.trim().toLowerCase();
  return allowlist.split(",").some(value => value.trim().toLowerCase() === normalized && normalized.length > 0);
}
