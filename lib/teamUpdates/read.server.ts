import "server-only";
import { z } from "zod";
import { selectTeamUpdates, updateTeamUpdateStatus } from "@/lib/data/teamUpdates.server";
import { teamUpdateStatusSchema, type TeamUpdate, type TeamUpdateStatus } from "./contracts";

const listOptionsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(20),
  status: teamUpdateStatusSchema.optional(),
}).strict();

export async function listTeamUpdates(
  businessId: string,
  options: { limit?: number; status?: TeamUpdateStatus } = {},
): Promise<TeamUpdate[]> {
  const id = z.string().uuid().parse(businessId);
  const { limit, status } = listOptionsSchema.parse(options);
  return selectTeamUpdates(id, limit, status);
}

export async function setTeamUpdateStatus(id: string, status: TeamUpdateStatus): Promise<void> {
  const updateId = z.string().uuid().parse(id);
  const nextStatus = teamUpdateStatusSchema.parse(status);
  return updateTeamUpdateStatus(updateId, nextStatus);
}
