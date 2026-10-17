import {describe,expect,it} from "vitest";
import {coversRequestedGoal,fallbackCallForGoal,requestScopeSchema,normalizeRequestedGoals,reconcileRequestScopes,reconcileRequestScopesDetailed,scopeAuditSchema,
  unavailableGoalText,goalLabel,type RequestedGoal} from "./requestScope";

const goal=(domain:RequestedGoal["domain"],period:RequestedGoal["period"]="month_to_date"):
RequestedGoal=>({domain,period,from:null,to:null,comparison_period:null,comparison_from:null,comparison_to:null});
describe("Bounded semantic request-scope enforcement",()=>{
  it("keeps four independently named goals and rejects over-budget declarations",()=>{
    const four=[goal("total_business_costs"),goal("staff_cost"),goal("menu_count"),goal("pricing_review")];
    expect(requestScopeSchema.parse({goals:four}).goals.map((g:RequestedGoal)=>g.domain))
      .toEqual(["total_business_costs","staff_cost","menu_count","pricing_review"]);
    expect(()=>requestScopeSchema.parse({goals:[...four,goal("owner_profit"),goal("sales")]})).toThrow();
  });
  it("never accepts staff as total business costs, or wrong staff and financial periods",()=>{
    const labor={name:"get_staff" as const,arguments:{view:"labor_cost",period:"month_to_date",from:null,to:null}};
    const costs={name:"get_financials" as const,
      arguments:{metric:"total_business_costs",period:"month_to_date",from:null,to:null}};
    expect(coversRequestedGoal(goal("staff_cost"),labor)).toBe(true);
    expect(coversRequestedGoal(goal("total_business_costs"),labor)).toBe(false);
    expect(coversRequestedGoal(goal("total_business_costs"),costs)).toBe(true);
    expect(coversRequestedGoal(goal("total_business_costs","today"),costs)).toBe(false);
    expect(coversRequestedGoal(goal("staff_cost","today"),labor)).toBe(false);
  });
  it("uses authorized read tools and month-to-date periods for deterministic repair",()=>{
    const bill=fallbackCallForGoal(goal("total_business_costs"));
    const labor=fallbackCallForGoal(goal("staff_cost"));
    expect(bill).toMatchObject({name:"get_financials",arguments:{metric:"total_business_costs",period:"month_to_date"}});
    expect(labor).toMatchObject({name:"get_staff",arguments:{view:"labor_cost",period:"month_to_date"}});
    expect(fallbackCallForGoal(goal("pricing_review"))?.name).toBe("get_pricing");
    expect(fallbackCallForGoal(goal("menu_count"))?.name).toBe("get_menu");
    expect(fallbackCallForGoal(goal("comparison"))).toBeNull();
  });
  it("localizes owner-facing missing-domain and core fact labels",()=>{
    expect(unavailableGoalText("total_business_costs","en"))
      .toBe("Total business costs: Unable to verify from the available records.");
    expect(goalLabel("staff_cost","es")).toBe("Costo del personal");
    expect(goalLabel("staff_cost","ar")).toBe("تكلفة الموظفين");
    expect(goalLabel("pricing_review","en")).toBe("Verified price changes");
  });
});

describe("independent semantic scope correction and period coverage",()=>{
  it("deduplicates goals by domain, period and date range without multiplying answer slots",()=>{
    const two=[goal("staff_cost"),goal("staff_cost"),goal("menu_count"),goal("staff_cost","today")];
    expect(normalizeRequestedGoals(two).map(g=>[g.domain,g.period])).toEqual([
      ["staff_cost","month_to_date"],["menu_count","month_to_date"],["staff_cost","today"],
    ]);
    expect(reconcileRequestScopes(two,[...two],true,false)).toHaveLength(3);
  });
  it("repairs missing declared goals only when the fresh audit confirms all original goals",()=>{
    const costs=goal("total_business_costs"),staff=goal("staff_cost"),
      menu=goal("menu_count"),pricing=goal("pricing_review");
    expect(reconcileRequestScopes([staff,menu,pricing],[costs,staff,menu,pricing],true,false))
      .toEqual([costs,staff,menu,pricing]);
    expect(reconcileRequestScopes([costs,staff,menu],[costs,staff,menu,pricing],true,false))
      .toHaveLength(4);
    expect(reconcileRequestScopes([costs,staff,menu],[staff,menu,pricing],true,false))
      .toEqual([staff,menu,pricing,costs]);
    expect(reconcileRequestScopes([staff,menu,pricing],[costs,staff,menu,pricing],false,false)).toBeNull();
    expect(reconcileRequestScopes([staff,menu,pricing],[costs,staff,menu,pricing],true,true)).toBeNull();
  });
  it("rejects malformed, over-five-goal and business selector fields",()=>{
    expect(()=>scopeAuditSchema.parse({complete:true,ambiguous:false,goals:[goal("staff_cost")],
      business_id:"other"})).toThrow();
    expect(()=>requestScopeSchema.parse({goals:[goal("staff_cost"),goal("menu_count"),
      goal("sales"),goal("pricing_review"),goal("team"),goal("overview")]})).toThrow();
    expect(()=>requestScopeSchema.parse({goals:[{...goal("menu_count"),sql:"select 1"}]})).toThrow();
    expect(()=>requestScopeSchema.parse({goals:[{...goal("menu_count"),period:"not-a-period"}]})).toThrow();
  });
  it("matches period-sensitive staffing, attendance, schedule and comparisons exactly",()=>{
    const a=(view:string,period:string)=>({name:"get_staff" as const,
      arguments:{view,period,from:null,to:null}});
    expect(coversRequestedGoal(goal("staffing","today"),a("current_staffing","today"))).toBe(true);
    expect(coversRequestedGoal(goal("staffing","today"),a("schedule","today"))).toBe(false);
    expect(coversRequestedGoal(goal("staff_attendance","month_to_date"),a("attendance","today"))).toBe(false);
    expect(coversRequestedGoal(goal("staff_schedule","week_to_date"),a("schedule","week_to_date"))).toBe(true);
    expect(coversRequestedGoal(goal("staff_schedule","week_to_date"),a("schedule","today"))).toBe(false);
    const comparison={...goal("comparison"),comparison_period:"previous_month" as const};
    const call={name:"compare_periods" as const,arguments:{
      metric:"total_business_costs",current_period:"month_to_date",current_from:null,current_to:null,
      comparison_period:"previous_month",comparison_from:null,comparison_to:null,
    }};
    expect(coversRequestedGoal(comparison,call)).toBe(true);
    expect(coversRequestedGoal(comparison,{...call,arguments:{...call.arguments,
      comparison_period:"previous_week"}})).toBe(false);
    expect(coversRequestedGoal({...comparison,comparison_period:null},call)).toBe(false);
  });
});

describe("Remaining period-sensitive goal reads",()=>{
  it("rejects wrong periods for sales, distinct items, owner profit, spending and bills",()=>{
    const date={period:"month_to_date",from:null,to:null};
    const rows=[
      [goal("sales"),{name:"get_sales" as const,arguments:{metric:"net_sales",...date}}],
      [goal("distinct_products"),{name:"get_sales" as const,arguments:{metric:"distinct_products",...date}}],
      [goal("owner_profit"),{name:"get_financials" as const,arguments:{metric:"owner_profit",...date}}],
      [goal("recorded_spending"),{name:"get_financials" as const,arguments:{metric:"recorded_spending",...date}}],
      [goal("monthly_bills"),{name:"get_financials" as const,arguments:{metric:"monthly_bills",...date}}],
    ] as const;
    for(const [requested,read] of rows){
      expect(coversRequestedGoal(requested,read)).toBe(true);
      expect(coversRequestedGoal(requested,{...read,arguments:{...read.arguments,
        period:"today"}})).toBe(false);
    }
    const custom={...goal("staff_cost","custom"),from:"2026-10-01",to:"2026-10-09"};
    expect(coversRequestedGoal(custom,{name:"get_staff",arguments:{
      view:"labor_cost",period:"custom",from:"2026-10-01",to:"2026-10-08",
    }})).toBe(false);
  });
});

describe("Canonical named-period identity without weakening custom-date matching",()=>{
  const named=(period:RequestedGoal["period"],from:string|null,to:string|null):RequestedGoal=>({
    ...goal("total_business_costs",period),from,to,
  });
  it("A: reconciles month_to_date with and without redundant concrete dates",()=>{
    const implied=named("month_to_date",null,null);
    const explicit=named("month_to_date","2026-10-01","2026-10-12");
    expect(normalizeRequestedGoals([implied,explicit])).toEqual([implied]);
    expect(normalizeRequestedGoals([explicit,implied])).toEqual([implied]);
    expect(reconcileRequestScopes([implied],[explicit],true,false)).toEqual([implied]);
    expect(reconcileRequestScopes([explicit],[implied],true,false)).toEqual([implied]);
    const read={name:"get_financials" as const,
      arguments:{metric:"total_business_costs",period:"month_to_date",from:"2026-10-01",to:"2026-10-12"}};
    expect(coversRequestedGoal(implied,read)).toBe(true);
    expect(coversRequestedGoal(explicit,{...read,arguments:{...read.arguments,from:null,to:null}})).toBe(true);
    expect(coversRequestedGoal(implied,{...read,arguments:{...read.arguments,period:"previous_month"}})).toBe(false);
  });
  it("B: different CUSTOM date ranges stay distinct and conflict",()=>{
    const a=named("custom","2026-10-01","2026-10-09");
    const b=named("custom","2026-10-02","2026-10-09");
    expect(normalizeRequestedGoals([a,b])).toHaveLength(2);
    expect(reconcileRequestScopes([a],[b],true,false)).toBeNull();
    const read={name:"get_financials" as const,
      arguments:{metric:"total_business_costs",period:"custom",from:"2026-10-01",to:"2026-10-09"}};
    expect(coversRequestedGoal(a,read)).toBe(true);
    expect(coversRequestedGoal(b,read)).toBe(false);
    expect(coversRequestedGoal(a,{...read,arguments:{...read.arguments,to:"2026-10-10"}})).toBe(false);
    expect(coversRequestedGoal(named("custom",null,null),read)).toBe(false);
  });
  it("C: comparison with named periods ignores BOTH sets of redundant concrete dates",()=>{
    const base={...goal("comparison","month_to_date"),comparison_period:"previous_month" as const};
    const concrete={...base,from:"2026-10-01",to:"2026-10-12",
      comparison_from:"2026-09-01",comparison_to:"2026-09-30"};
    expect(normalizeRequestedGoals([base,concrete])).toEqual([base]);
    expect(reconcileRequestScopes([base],[concrete],true,false)).toEqual([base]);
    expect(reconcileRequestScopes([concrete],[base],true,false)).toEqual([base]);
    const read={name:"compare_periods" as const,arguments:{
      metric:"total_business_costs",current_period:"month_to_date",
      current_from:"2026-10-01",current_to:"2026-10-12",comparison_period:"previous_month",
      comparison_from:"2026-09-01",comparison_to:"2026-09-30",
    }};
    expect(coversRequestedGoal(base,read)).toBe(true);
    expect(coversRequestedGoal(concrete,{...read,arguments:{
      ...read.arguments,current_from:null,current_to:null,comparison_from:null,comparison_to:null,
    }})).toBe(true);
  });
  it("D: comparison CUSTOM dates are exact, independently for each side",()=>{
    const custom={
      ...goal("comparison","custom"),from:"2026-10-01",to:"2026-10-09",
      comparison_period:"custom" as const,comparison_from:"2026-09-01",comparison_to:"2026-09-09",
    };
    const read={name:"compare_periods" as const,arguments:{
      metric:"total_business_costs",current_period:"custom",current_from:"2026-10-01",
      current_to:"2026-10-09",comparison_period:"custom",
      comparison_from:"2026-09-01",comparison_to:"2026-09-09",
    }};
    expect(coversRequestedGoal(custom,read)).toBe(true);
    const changedCurrent={...custom,from:"2026-10-02"};
    const changedPrevious={...custom,comparison_to:"2026-09-10"};
    expect(reconcileRequestScopes([custom],[changedCurrent],true,false)).toBeNull();
    expect(reconcileRequestScopes([custom],[changedPrevious],true,false)).toBeNull();
    expect(coversRequestedGoal(custom,{...read,arguments:{
      ...read.arguments,current_from:"2026-10-02",
    }})).toBe(false);
    expect(coversRequestedGoal(custom,{...read,arguments:{
      ...read.arguments,comparison_to:"2026-09-10",
    }})).toBe(false);
    // Only the custom side matters when the other side is a named period.
    const mixed={...custom,period:"month_to_date" as const,from:null,to:null};
    expect(coversRequestedGoal(mixed,{...read,arguments:{
      ...read.arguments,current_period:"month_to_date",current_from:"2026-10-01",
    }})).toBe(true);
  });
});

describe("Snapshot domain period identity",()=>{
  const snap=["team","menu_count","pricing_review","owner_rules","break_even","staff_coverage"] as const;
  for(const domain of snap)it(domain+" is the same goal regardless of meaningless period metadata",()=>{
    const today={...goal(domain,"today"),from:"2026-10-12",to:"2026-10-12"};
    const monthly={...goal(domain,"month_to_date"),from:null,to:null};
    expect(reconcileRequestScopes([today],[monthly],true,false)).toEqual([monthly]);
    expect(reconcileRequestScopes([monthly],[today],true,false)).toEqual([monthly]);
    expect(normalizeRequestedGoals([today,monthly])).toHaveLength(1);
  });
  it("Team / today and Team / month-to-date reconcile without false clarification",()=>{
    expect(reconcileRequestScopes([goal("team","today")],[goal("team","month_to_date")],true,false))
      .toEqual([goal("team","month_to_date")]);
    expect(coversRequestedGoal(goal("team","today"),{name:"get_team",arguments:{
      status:"needs_you",view:"tasks",agent:"all",limit:5,
    }})).toBe(true);
  });
  it("real sales and staff labor remain strictly period-sensitive",()=>{
    expect(reconcileRequestScopes([goal("sales","today")],[goal("sales","month_to_date")],true,false)).toBeNull();
    expect(reconcileRequestScopes([goal("staff_cost","today")],[goal("staff_cost","month_to_date")],true,false)).toBeNull();
    expect(coversRequestedGoal(goal("sales","today"),{name:"get_sales",arguments:{period:"month_to_date"}})).toBe(false);
    expect(coversRequestedGoal(goal("staff_cost","today"),{name:"get_staff",arguments:{
      view:"labor_cost",period:"month_to_date",
    }})).toBe(false);
  });
  it("overview genuinely changes between today and month-to-date, unlike persisted Team inbox",()=>{
    expect(reconcileRequestScopes([goal("overview","today")],[goal("overview","month_to_date")],true,false)).toBeNull();
    expect(coversRequestedGoal(goal("overview","today"),{name:"get_cafe_overview",arguments:{focus:"today"}})).toBe(true);
    expect(coversRequestedGoal(goal("overview","today"),{name:"get_cafe_overview",arguments:{focus:"month_to_date"}})).toBe(false);
  });
});

describe("Bounded reconciliation outcomes and four-domain completeness",()=>{
  const g=(domain:RequestedGoal["domain"],period:RequestedGoal["period"]="month_to_date"):RequestedGoal=>({
    domain,period,from:null,to:null,comparison_period:null,comparison_from:null,comparison_to:null,
  });
  it("accepts only canonical equivalents; Team is NOT interchangeable with staff coverage or overview",()=>{
    expect(reconcileRequestScopesDetailed([g("team","today")],[g("team","month_to_date")],true,false))
      .toMatchObject({outcome:"accepted",goals:[g("team")],
        declaredDomains:["team"],auditedDomains:["team"],normalizedDomains:["team"]});
    for(const domain of ["staff_coverage","overview"] as const){
      const x=reconcileRequestScopesDetailed([g("team")],[g(domain)],true,false);
      expect(x).toMatchObject({outcome:"semantic_conflict",goals:null});
    }
    expect(reconcileRequestScopesDetailed([g("sales","today")],[g("sales")],true,false))
      .toMatchObject({outcome:"semantic_conflict",goals:null});
  });
  it("never treats genuine audit ambiguity or incompleteness as accepted",()=>{
    expect(reconcileRequestScopesDetailed([g("team")],[g("team")],false,false).outcome)
      .toBe("audit_incomplete");
    expect(reconcileRequestScopesDetailed([g("team")],[g("team")],true,true).outcome)
      .toBe("audit_ambiguous");
  });
  it("repairs the original four-part costs/staff/menu/pricing question, never losing omitted total costs",()=>{
    const all=[g("total_business_costs"),g("staff_cost"),g("menu_count"),g("pricing_review")];
    const first=all.slice(1); // planner omitted total business costs
    const audit=reconcileRequestScopesDetailed(first,all,true,false);
    expect(audit.outcome).toBe("accepted");
    expect(audit.goals?.map(x=>x.domain)).toEqual([
      "total_business_costs","staff_cost","menu_count","pricing_review",
    ]);
    expect(reconcileRequestScopesDetailed(all,first,true,false))
      .toMatchObject({outcome:"declared_goal_missing",goals:null});
  });
  it("keeps period-sensitive dates and no extra business selector",()=>{
    expect(reconcileRequestScopesDetailed([g("staff_cost","today")],[g("staff_cost")],true,false))
      .toMatchObject({outcome:"semantic_conflict",goals:null});
    expect(reconcileRequestScopesDetailed([g("staff_coverage")],[g("team")],true,false))
      .toMatchObject({outcome:"semantic_conflict",goals:null});
  });
});
