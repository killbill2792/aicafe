export const DEFAULT_TEAM_RULES={
 meal_break_enabled:true,meal_break_minutes:30,meal_break_after_minutes:300,
 rest_break_enabled:true,rest_break_minutes:10,rest_break_every_minutes:240,
 weekly_ot_enabled:true,weekly_ot_after_minutes:2400,ot_multiplier_bp:15000,
 daily_ot_enabled:false,daily_ot_after_minutes:480,
 max_shift_enabled:true,max_shift_minutes:600,min_shift_enabled:true,min_shift_minutes:180,
 min_rest_enabled:true,min_rest_minutes:600,coverage_enabled:true,min_headcount:2
} as const;
