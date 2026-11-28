import { refresh } from "next/cache";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import WorkforceProfileForm, { type ProfileSaveStatus } from "@/components/luna/WorkforceProfileForm";
import { Link, redirect } from "@/i18n/navigation";
import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { workforceRoster, type EmployeeKey } from "@/lib/luna/workforce/roster";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import enMessages from "@/messages/en.json";

export const dynamic = "force-dynamic";

async function openWorkforceConversation(employeeKey: EmployeeKey, businessId: string) {
  "use server";
  const { scope } = await authenticatedConversationContext();
  if (scope.businessId !== businessId) notFound();
  const { data, error } = await createAdminSupabaseClient().rpc("luna_open_employee_thread", {
    p_business_id: scope.businessId, p_owner_user_id: scope.ownerUserId, p_employee_key: employeeKey,
  });
  if (error) throw error;
  if (typeof data !== "string") throw new Error("luna_employee_thread_unavailable");
  redirect({ href: { pathname: "/", query: { thread: data } }, locale: await getLocale() });
}

async function saveProfile(
  employeeKey: EmployeeKey, businessId: string, _previous: ProfileSaveStatus, form: FormData,
): Promise<ProfileSaveStatus> {
  "use server";

  const displayName = form.get("displayName");
  const jobTitle = form.get("jobTitle");
  if (typeof displayName !== "string" || typeof jobTitle !== "string" ||
      displayName.length > 80 || jobTitle.length > 120 || /\p{Cc}/u.test(displayName + jobTitle)) return "invalid";

  try {
    const { scope } = await authenticatedConversationContext();
    if (scope.businessId !== businessId) return "failed";
    const db = await createServerSupabaseClient();
    const { error } = await db.rpc("luna_save_workforce_profile", {
      p_business_id: scope.businessId,
      p_employee_key: employeeKey,
      p_display_name: displayName.trim() || null,
      p_job_title: jobTitle.trim() || null,
    });
    if (error) {
      console.error("workforce_profile_save_failed", error.code);
      return "failed";
    }
  } catch (error) {
    console.error("workforce_profile_save_failed", error instanceof ConversationApiError ? error.code : undefined);
    return "failed";
  }
  refresh();
  return "saved";
}

export default async function WorkforcePage() {
  await requireOwnBusiness();
  const { scope } = await authenticatedConversationContext().catch((error) => {
    if (error instanceof ConversationApiError) notFound();
    throw error;
  });
  const db = await createServerSupabaseClient();
  const admin = createAdminSupabaseClient();
  const [{ data, error }, rollout, threads] = await Promise.all([
    db.from("luna_workforce_profiles").select("employee_key, display_name, job_title").eq("business_id", scope.businessId),
    admin.from("luna_rollouts").select("enabled").eq("business_id", scope.businessId).maybeSingle(),
    admin.from("luna_employee_threads").select("employee_key").eq("business_id", scope.businessId).eq("owner_user_id", scope.ownerUserId),
  ]);
  if (error) throw error;
  if (rollout.error || threads.error) throw rollout.error ?? threads.error;
  const copy = enMessages.Workforce;
  const overrides = new Map((data ?? []).map((profile) => [profile.employee_key, profile]));
  const existingThreads = new Set((threads.data ?? []).map((binding) => binding.employee_key));

  return <PageShell wide className="flex flex-col gap-4 px-4 pb-28 pt-6">
    <Link href="/operations" className="flex min-h-12 items-center self-start text-[17px] font-semibold text-accent-text underline">{copy.back}</Link>
    <h1 className="font-headline text-3xl font-bold text-ink">{copy.title}</h1>
    <div className="grid gap-4 md:grid-cols-2">
      {workforceRoster(data ?? []).map((profile) => <article key={profile.key} className="rounded-card-lg border border-line bg-card p-4 text-ink">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface2 text-xl font-bold">
            {profile.avatar
              ? <Image src={profile.avatar} alt="" width={56} height={56} className="h-full w-full object-cover object-top" />
              : Array.from(profile.name)[0]?.toLocaleUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 dir="auto" className="wrap-break-word text-xl font-bold">{profile.name}</h2>
            <p dir="auto" className="wrap-break-word text-[17px] text-ink-muted">{profile.title}</p>
          </div>
        </div>
        <ul className="mt-4 list-disc space-y-1 ps-5 text-[17px]">
          {profile.responsibilities.map((responsibility) => <li key={responsibility}>{responsibility}</li>)}
        </ul>
        <WorkforceProfileForm name={overrides.get(profile.key)?.display_name ?? ""}
          title={overrides.get(profile.key)?.job_title ?? ""} namePlaceholder={profile.name} titlePlaceholder={profile.title} copy={copy}
          save={saveProfile.bind(null, profile.key, scope.businessId)} />
        {(rollout.data?.enabled || existingThreads.has(profile.key)) &&
          <form action={openWorkforceConversation.bind(null, profile.key, scope.businessId)}>
            <button className="mt-3 flex min-h-12 items-center font-semibold text-accent-text underline">
              {rollout.data?.enabled ? copy.openConversation : copy.openHistory}
            </button>
          </form>}
      </article>)}
    </div>
  </PageShell>;
}
