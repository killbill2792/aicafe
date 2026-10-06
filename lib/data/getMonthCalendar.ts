import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getMonthCalendarFromDb, type MonthCalendarData } from "./monthCalendar.server";
import { RUNNING_COST_CODES } from "./runningCostCatalog";
import type { BusinessSnapshot } from "./types";

function daysInMonthKey(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

/** An honest "nothing recorded" month — used for the fixture/demo fallback below a month it has
 * no data for, rather than fabricating days or bills that were never entered. */
function emptyMonth(monthKey: string): MonthCalendarData {
  return {
    monthKey,
    daysInMonth: daysInMonthKey(monthKey),
    days: [],
    categoryAmounts: RUNNING_COST_CODES.map((categoryCode) => ({ categoryCode, monthKey, amountCents: 0, isEstimate: false, isMissing: true })),
    openHours: null,
  };
}

/**
 * The Money calendar's month-specific read model — for the currently-loaded month this reuses the
 * already-fetched `snapshot` (no extra query); any other month goes to the real historical query
 * in `monthCalendar.server.ts`, which never substitutes today's current bill values for a past
 * month's (see that file's doc comment).
 */
export async function getMonthCalendar(monthKey: string, snapshot: BusinessSnapshot): Promise<MonthCalendarData> {
  if (monthKey === snapshot.monthKey) {
    return {
      monthKey,
      daysInMonth: snapshot.daysInMonth,
      days: snapshot.monthActualDays,
      categoryAmounts: snapshot.runningCostLines.map((l) => ({
        categoryCode: l.categoryCode,
        monthKey,
        amountCents: l.amountCents,
        isEstimate: l.isEstimate,
        isMissing: l.isMissing,
      })),
      openHours: snapshot.business.openHours,
    };
  }

  if (!isSupabaseConfigured()) return emptyMonth(monthKey);

  const supabase = await createServerSupabaseClient();
  return getMonthCalendarFromDb(supabase, snapshot.business.id, monthKey, false);
}
