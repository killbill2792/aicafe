import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { createRuleInput, rulePageInput } from "@/lib/ai/policies/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const offset = parseInput(rulePageInput, {
      offset: new URL(request.url).searchParams.get("offset") ?? undefined,
    }).offset;
    const service = await authenticatedTeamRulesService();
    return conversationJson(await service.listRules(offset));
  } catch (error) {
    return conversationError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const input = parseInput(createRuleInput, await readBoundedJson(request));
    const service = await authenticatedTeamRulesService();
    const rule = await service.createDraft(input.agentId, input.instruction);
    return conversationJson({ rule }, 201);
  } catch (error) {
    return conversationError(error);
  }
}
