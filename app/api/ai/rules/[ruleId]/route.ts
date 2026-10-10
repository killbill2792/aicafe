import { authenticatedTeamRulesService } from "@/lib/ai/policies/auth.server";
import { reviewRuleInput, ruleIdInput } from "@/lib/ai/policies/contracts";
import { conversationError, conversationJson, parseInput, readBoundedJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";
import { RuleConflict, RuleNotFound, RuleTransitionDenied } from "@/lib/ai/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ ruleId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const { ruleId } = await context.params;
    const id = parseInput(ruleIdInput, ruleId);
    const input = parseInput(reviewRuleInput, await readBoundedJson(request));
    const service = await authenticatedTeamRulesService();
    const rule = await service.reviewRule(id, input.expectedVersion, input.decision);
    return conversationJson({ rule });
  } catch (error) {
    if (error instanceof RuleNotFound) return conversationJson({ error: "rule_not_found" }, 404);
    if (error instanceof RuleConflict || error instanceof RuleTransitionDenied) {
      return conversationJson({ error: "rule_review_conflict" }, 409);
    }
    return conversationError(error);
  }
}
