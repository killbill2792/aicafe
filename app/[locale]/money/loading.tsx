import { SkeletonBlock, SkeletonCard } from "@/components/shared/Skeleton";

export default function Loading() {
  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <SkeletonBlock className="h-8 w-32" />
      <SkeletonBlock className="h-11 w-full rounded-3xl" />
      <SkeletonCard lines={4} className="h-40" />
      <SkeletonCard lines={5} />
    </main>
  );
}
