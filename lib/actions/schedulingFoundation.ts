"use server";

import {
  executeFoundationCommand,
  readSchedulingFoundation,
} from "@/lib/scheduling/foundation.server";

/**
 * Typed, owner-only manual scheduling foundation operations.
 * No Supervisor/Olivia chat tool is registered in PR 1A.
 * Both functions are default-off until the reviewed migration is applied.
 */
export async function saveSchedulingFoundationRecord(input: unknown) {
  return executeFoundationCommand(input);
}

export async function getSchedulingFoundationRecords() {
  return readSchedulingFoundation();
}
