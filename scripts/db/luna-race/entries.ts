import { randomUUID } from "node:crypto";
import { assertCafeAiAccess } from "@/lib/access/access.server";
import { readOwnerMessage } from "@/lib/ai/agent/jobs.server";
import { approveLoop, commitLoop, loopRegistry, proposeLoop, type OwnerLoopScope } from "@/lib/ai/supervisor/loop/engine";
import { SupervisorEffectGateway } from "@/lib/ai/supervisor/loop/effectGateway.server";
import { gmailCapability, gmailCapabilityId } from "@/lib/ai/supervisor/loop/gmail.server";
import { SupabaseLoopRepository } from "@/lib/ai/supervisor/loop/supabase.server";
import { ownerModelCallsLimit } from "@/lib/ai/conversations/usage.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { admitDurableChat, processDurableRun } from "@/lib/ai/supervisor/runs/worker.server";
import { processLunaAssignment } from "@/lib/luna/runtime/assignment-worker.server";
import { encryptToken } from "@/lib/connectors/crypto.server";
import { GOOGLE_MODIFY_SCOPE } from "@/lib/connectors/gmail/oauth.server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

const gmailRegistry = loopRegistry(gmailCapability);
const repository = new SupabaseLoopRepository();

export async function prepare(scope: OwnerLoopScope, requestKey: string) {
  const db = createAdminSupabaseClient();
  const email = `${scope.ownerUserId}@example.invalid`;
  const account = await db.from("connector_accounts").insert({
    business_id: scope.businessId, owner_user_id: scope.ownerUserId, provider: "gmail",
    provider_subject: randomUUID(), email, granted_scopes: [GOOGLE_MODIFY_SCOPE],
    enabled_operations: ["read", "send"], status: "active",
  }).select("id,generation").single();
  if (account.error || !account.data) throw new Error("race_mailbox_seed_failed", { cause: account.error });
  const { error } = await db.from("connector_credentials").insert({
    account_id: account.data.id, generation: account.data.generation,
    access_token_enc: encryptToken("disposable-gmail-access"), refresh_token_enc: encryptToken("disposable-gmail-refresh"),
    token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  if (error) throw new Error("race_credentials_seed_failed", { cause: error });
  const { businessId, ownerUserId, threadId, locale } = scope;
  const runScope = { businessId, ownerUserId, threadId };
  const ownerMessage = await readOwnerMessage(runScope, threadId, requestKey);
  const run = await admitDurableChat(runScope, ownerMessage, { locale, attachmentIds: [] });
  const draft = await proposeLoop(scope, gmailRegistry, repository, gmailCapabilityId, {
    operation: "send", action: null, to: ["recipient@example.invalid"], cc: [], bcc: [],
    subject: "Shift report", body: "The disposable shift report is ready.",
    messageId: null, threadId: null, labelId: null, labelName: null,
  }, randomUUID());
  const approved = await approveLoop(scope, repository, draft.id, draft.revision, gmailRegistry);
  return { runId: run.id, proposalId: approved.id, revision: approved.revision };
}

export async function dispatch(engine: "legacy" | "replacement", scope: OwnerLoopScope, runId: string) {
  if (engine === "legacy") return processDurableRun(runId);
  const db = createAdminSupabaseClient();
  const { businessId, ownerUserId, threadId } = scope;
  const signal = AbortSignal.timeout(55_000);
  return processLunaAssignment({
    scope: { businessId, ownerUserId, threadId }, runId, signal,
    rpc: async (name, params) => {
      const { data, error } = await db.rpc(name, params).abortSignal(signal);
      if (error) throw new Error(error.message);
      return data;
    },
    accounting: {
      db, ownerDailyCap: ownerModelCallsLimit(), authorize: () => assertCafeAiAccess(scope.businessId),
      budget: { maxElapsedMs: 55_000, maxModelCalls: 2, maxToolCalls: 1, maxInputTokens: 60_000, maxOutputTokens: 2400 },
    },
    buildRequest: async (context, steering) => ({
      model: configuredSupervisorModel(), instructions: "Respond to the persisted assignment.", max_output_tokens: 1200,
      input: [{ role: "user", content: context.originalInput.text ?? "" },
        ...steering.map(input => ({ role: "user", content: input.content }))],
    }),
  });
}

export async function commit(scope: OwnerLoopScope, proposalId: string, revision: number) {
  return commitLoop(scope, gmailRegistry, repository, proposalId, revision);
}

export async function recover(scope: OwnerLoopScope, proposalId: string) {
  const proposal = await repository.load(scope, proposalId);
  return new SupervisorEffectGateway().reconcileGmail(scope, proposalId, proposal.revision);
}
