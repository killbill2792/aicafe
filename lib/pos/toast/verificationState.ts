export function verificationFailure(previousVerified:boolean,category:string) {
  // A temporary outage, rate-limit or timeout does not revoke access or erase past verification.
  const transient=["unavailable","timeout","rate_limited","invalid_response"].includes(category);
  return {state:transient?(previousVerified?"verified":"configured"):
    ["missing_permissions","missing_scope_or_location"].includes(category)?"missing_permissions":
    category==="unauthorized_location"?"configured":"needs_reconnect",
    preserveVerification:transient};
}
