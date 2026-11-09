/** Owner-verified Vercel production Supervisor model contract (cafe-profit, 2026-11-09).
 * These are model IDs, NOT secrets, committed so GitHub coding agents can
 * reproduce production behavior without access to Vercel environment variables.
 * Production: SUPERVISOR_OPENAI_MODEL=gpt-6-luna
 * Configured fallback: SUPERVISOR_OPENAI_FALLBACK_MODEL=gpt-4.1-mini.
 * The fallback setting alone is NOT proof that any provider retry occurred.
 *
 * Historical DEFAULT_SUPERVISOR_OPENAI_MODEL is kept for the low-cost event
 * search/research consumers which import it directly. It is NOT the
 * production Supervisor conversation model; changing it would also alter
 * those independent paid event searches.
 */
export const PRODUCTION_SUPERVISOR_OPENAI_MODEL="gpt-6-luna" as const;
export const PRODUCTION_SUPERVISOR_OPENAI_FALLBACK_MODEL="gpt-4.1-mini" as const;
export const DEFAULT_SUPERVISOR_OPENAI_MODEL="gpt-4.1-mini" as const;
export function configuredSupervisorModel():string{
  return process.env.SUPERVISOR_OPENAI_MODEL?.trim()||PRODUCTION_SUPERVISOR_OPENAI_MODEL;
}
