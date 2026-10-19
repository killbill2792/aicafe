/** App-local authentication paths. Used by both mobile and desktop navigation. */
export const AUTH_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password"] as const;

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((path) => pathname === path);
}
