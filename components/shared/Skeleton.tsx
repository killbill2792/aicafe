/** Skeleton cards in the same layout as real content — never a blank screen or bare spinner
 * (docs/03-screens.md "Global states"). `prefers-reduced-motion` disables the shimmer. */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-[#EDE5D9] motion-reduce:animate-none ${className}`} />;
}

export function SkeletonCard({ lines = 2, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 rounded-card-lg bg-card p-4 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBlock key={i} className={i === 0 ? "h-6 w-2/3" : "h-4 w-full"} />
      ))}
    </div>
  );
}
