const TOTAL_STEPS = 5;

export default function OnboardingProgress({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={TOTAL_STEPS}>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => (
        <span key={n} className={`h-2 flex-1 rounded-full ${n <= step ? "bg-good" : "bg-line"}`} />
      ))}
    </div>
  );
}
