/**
 * Olivia PR 2 pure planner contract. All inputs are owner-reviewed snapshots,
 * never model-issued commands or instructions to write payroll/published shifts.
 * Dates: ISO civil YYYY-MM-DD. All cents: nonnegative safe integers.
 */
import type {
  RecurringAvailability, AvailabilityException, PreferenceWindow,
  CompensationProvenance, EmployeeWageSnapshot,
} from "./availability";

export type PlannerDate = string;
export type PlannerWindow = { start_local: string; end_local: string; overnight: boolean };
export type PlannerLocation = { id: string; timezone: string };
export type PlannerCoverage = PlannerWindow & {
  id: string; locationId: string; dayOfWeek?: number | null;
  localDate?: string | null; effectiveFrom?: string | null; effectiveTo?: string | null;
  minHeadcount: number; qualificationCode?: string | null;
  minOverlapMinutes?: number; priority: "required" | "advisory";
};
export type PlannerQualification = {
  code: string; locationId?: string | null;
  validFrom: string; validTo?: string | null; confirmed: boolean;
};
export type PlannerPreference = PreferenceWindow;
export type PlannerEmployee = {
  id: string; displayName: string; active: boolean;
  isOwner?: boolean; ownerOpportunityCentsPerHour?: number | null;
  eligibleLocationIds?: string[];
  recurring: RecurringAvailability[]; exceptions: AvailabilityException[];
  preferences?: PlannerPreference[]; unavailableWeekdays?: Array<{
    effective_from: string; effective_to?: string | null;
    unavailable_weekdays: number[]; confirmation: "unconfirmed" | "owner_confirmed";
  }>;
  qualifications: PlannerQualification[];
  minWeeklyMinutes?: number; desiredWeeklyMinutes?: number | null;
  maxDailyMinutes?: number | null; maxWeeklyMinutes?: number | null;
  /** Current canonical wage snapshot, NOT historical timecards. */
  wage: EmployeeWageSnapshot;
  provenance: CompensationProvenance;
  /** Only after an owner has verified the salary-hours conversion. */
  verifiedSalaryHourlyCents?: number | null;
  /** Approved paid hours/week for canonical salary-to-hourly conversion. */
  verifiedSalaryHoursPerWeek?: number | null;
  /** Explicitly attested wage eligibility, never inferred from a missing wage. */
  eligibleZeroVerified?: boolean;
};
export type PlannerPinned = {
  employeeId: string; locationId: string;
  startAt: string; endAt: string;
};
export type PlannerRuleProfile = {
  /** Jurisdiction-specific rule set was actually verified, never inferred. */
  verified: boolean;
  /** Reviewed policy source/version, not untrusted owner instructions. */
  source?: string;
  /** Explicit configured jurisdictions for all scheduled locations. */
  jurisdictionByLocationId?: Record<string,string>;
  /** Explicit verified classification per worker; names are not IDs. */
  classificationByEmployeeId?: Record<string,string>;
  maxContinuousWorkMinutes?: number | null;
  unpaidMealMinutes?: number | null;
  /** Verified paid rest break duration; without this no paid rest is invented. */
  paidRestMinutes?: number | null;
  minRestBetweenShiftsMinutes?: number | null;
  overtime?: {
    verified: boolean;
    dailyAfterMinutes?: number | null;
    weeklyAfterMinutes?: number | null;
    /** e.g. 3/2; avoid floating precision in wage premiums. */
    multiplierNumerator: number;
    multiplierDenominator: number;
  } | null;
};
export type PlannerBurden = { rate: number; status: "verified" | "estimate" | "unavailable" };
export type PlannerInput = {
  horizonStart: string; locations: PlannerLocation[];
  employees: PlannerEmployee[]; coverage: PlannerCoverage[];
  pinned?: PlannerPinned[];
  ruleProfile?: PlannerRuleProfile | null;
  burden?: PlannerBurden | null;
  /** 5/10/15/30/60 minute finite grid for verified break durations. */
  slotMinutes?: 5 | 10 | 15 | 30 | 60;
  maxNodes?: number; beamWidth?: number;
  /** Recorded evidence is never needed to run manual coverage. */
  hourlySalesEvidence?: null;
};
export type PlannerBreak = { startAt: string; endAt: string; paid: boolean };
export type PlannerShift = {
  employeeId: string; locationId: string;
  startAt: string; endAt: string;
  paidMinutes: number; breaks: PlannerBreak[];
  pinned: boolean;
};
export type PlannerGapReason =
  | "no_active_staff" | "qualification_missing" | "no_confirmed_availability"
  | "capacity_or_overlap" | "break_or_rest_constraint"
  | "daily_hour_limit" | "weekly_hour_limit" | "date_specific_cap"
  | "pinned_conflict" | "solver_budget";
export type PlannerGap = {
  coverageId: string; locationId: string;
  startAt: string; endAt: string;
  qualificationCode: string | null; missingHeadcount: number;
  reason: PlannerGapReason;
};
export type PlannerCost = {
  /** Unknown means unavailable, NEVER $0. */
  /** Total modeled hourly cash plus allocated salary equivalent; not a
   * claim that scheduling a salaried employee incurs incremental payroll. */
  cashWagesCents: number | null;
  /** Portion of cashWagesCents allocated from verified salary equivalents. */
  allocatedSalaryCents: number | null;
  loadedPayrollCents: number | null;
  ownerOpportunityCents: number | null;
  ownerMinutes: number;
  costState: "verified" | "estimate" | "unavailable";
  missingWageEmployeeIds: string[];
};
export type PlannerScenario = {
  objective: "cash" | "owner_time" | "balanced";
  shifts: PlannerShift[];
  gaps: PlannerGap[];
  completeCoverage: boolean;
  hardConstraintsSatisfied: boolean;
  ownerMinutes: number;
  cost: PlannerCost;
  preferencePenalty: number;
  exploredNodes: number;
  /** This is a modeled proposal, not a legally cleared publishable shift plan. */
  legalReview: "verified_profile" | "unverified_profile";
};
export type PlannerComparison = {
  left: PlannerScenario["objective"]; right: PlannerScenario["objective"];
  ownerMinutesDifference: number;
  cashWagesDifferenceCents: number | null;
  loadedPayrollDifferenceCents: number | null;
};
export type PlannerResult = {
  status: "feasible" | "infeasible" | "unproven";
  horizonStart: string; horizonEnd: string;
  scenarios: PlannerScenario[];
  best: PlannerScenario | null;
  comparisons: PlannerComparison[];
  /** Some constraints may be unknown without jurisdiction/verified wage data. */
  warnings: string[];
  /** Infeasible only for independently proven missing eligibility/capacity. */
  proof: "complete_candidate_solution" | "required_slot_has_no_eligible_worker" | "search_budget_exhausted" | "candidate_constraints_unresolved";
};
