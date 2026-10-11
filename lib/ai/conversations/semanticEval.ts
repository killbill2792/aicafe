export type PlannedTool={name:string;arguments:Record<string,unknown>};
export type AcceptableTool={name:string;arguments?:Record<string,unknown>};
/** All members of an acceptable plan are REQUIRED; an unrelated single tool never passes. */
export function matchesAcceptablePlan(actual:PlannedTool[],plans:AcceptableTool[][]) {
  return plans.some(plan=>plan.every(expected=>actual.some(call=>
    call.name===expected.name && Object.entries(expected.arguments??{}).every(([k,v])=>
      call.arguments[k]===v))));
}
