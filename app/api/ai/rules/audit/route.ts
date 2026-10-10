import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { rulePageInput } from "@/lib/ai/policies/contracts";
import { conversationError, conversationJson, parseInput } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const offset = parseInput(rulePageInput, {
      offset: new URL(request.url).searchParams.get("offset") ?? undefined,
    }).offset;
    const service = await authenticatedTeamRulesService();
    return conversationJson(await service.listEvents(offset));
  } catch (error) {
    return conversationError(error);
  }
}
