/** No env secrets are exported: this pure classifier returns only status codes. */
export type SupervisorChatUnavailableReason =
  | "explicitly_disabled"
  | "supabase_unconfigured"
  | "server_writer_unconfigured"
  | "owner_access_required"
  | "storage_unavailable";

export type SupervisorChatReadiness =
  | { enabled: true; reason: null }
  | { enabled: false; reason: SupervisorChatUnavailableReason };

export function supervisorChatConfigStatus(options: {
  configuredSupabase: boolean;
  serviceRolePresent: boolean;
  featureFlag?: string;
}): SupervisorChatReadiness {
  // An explicit false is the emergency operator kill switch.
  if (options.featureFlag?.trim().toLowerCase() === "false") {
    return { enabled: false, reason: "explicitly_disabled" };
  }
  if (!options.configuredSupabase) {
    return { enabled: false, reason: "supabase_unconfigured" };
  }
  if (!options.serviceRolePresent) {
    return { enabled: false, reason: "server_writer_unconfigured" };
  }
  // Missing flag is not a permanent "coming soon" state after all prerequisites
  // are installed. Real café/owner/database readiness is checked separately.
  return { enabled: true, reason: null };
}
