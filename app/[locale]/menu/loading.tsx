import { SkeletonBlock, SkeletonCard } from "@/components/shared/Skeleton";

export default function Loading() {
  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <SkeletonBlock className="h-8 w-48" />
      <SkeletonCard lines={3} className="h-44" />
      <SkeletonCard lines={6} />
    </main>
  );
}
