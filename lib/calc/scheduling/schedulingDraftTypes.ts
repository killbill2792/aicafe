import type {OpenHours} from "@/lib/business/openHours";
/** Legacy data-reader contract retained for other callers; not a scheduler. */
export type DraftEmployee={id:string;display_name:string;default_hourly_wage_cents:number|null;wage_period:string|null;wage_amount_cents:number|null;available_days?:number[]|null};
export type DraftRecurring={employee_id:string;day_of_week:number;start_time:string;end_time:string;effective_from:string;effective_to:string|null;unpaid_break_minutes:number|null};
export type DraftAvailability={employee_id:string;day_of_week:number;start_local:string;end_local:string;confirmation:string;source?:string|null;effective_from:string;effective_to:string|null};
export type DraftPreference={employee_id:string;max_weekly_minutes:number|null;effective_from:string;effective_to:string|null};
export type SchedulingDraftInputs={employees:DraftEmployee[];schedules:DraftRecurring[];availability:DraftAvailability[];preferences:DraftPreference[];
  openHours:OpenHours|null;prepMinutesBeforeOpen?:number;prepMinutesAfterClose?:number;unavailableDates?:Array<{employeeId:string;date:string;start?:string|null;end?:string|null;overnight?:boolean}>;timezone:string;timezoneDefaultedToUtc?:boolean;city:string|null;region:string|null;countryCode:string|null;missing?:string[]};
