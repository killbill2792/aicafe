/** Single, conservative OpenAI default if the deployment has no model override.
 * Real deployments may select other accessible models through server-only env.
 * A missing fallback is not silently replaced with an invented model.
 */
export const DEFAULT_SUPERVISOR_OPENAI_MODEL="gpt-4.1-mini" as const;
export function configuredSupervisorModel():string{
  return process.env.SUPERVISOR_OPENAI_MODEL?.trim()||DEFAULT_SUPERVISOR_OPENAI_MODEL;
}
export function configuredSupervisorFallbackModel():string|null{
  return process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL?.trim()||null;
}
