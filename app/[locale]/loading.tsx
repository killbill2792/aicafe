import { SkeletonBlock, SkeletonCard } from "@/components/shared/Skeleton";
import PageShell from "@/components/shared/PageShell";

export default function Loading() {
  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <SkeletonBlock className="h-8 w-40" />
      <SkeletonCard lines={3} />
      <SkeletonCard lines={2} />
      <SkeletonCard lines={2} />
    </PageShell>
  );
}
