import "server-only";

/** One per-café writer decision. Shadow mode may compare reads but MUST NOT
 * perform any new-path writes; legacy goals and check-ins stay enabled. */
export type ExperimentCutoverMode="legacy"|"shadow"|"new";
export type ExperimentCutoverGate={
 requested:unknown;
 parityProven:boolean;
 rollbackProven:boolean;
 releaseApproved:boolean;
};
export function resolveExperimentCutoverMode(gate:ExperimentCutoverGate):ExperimentCutoverMode{
 if(gate.requested==="shadow")return "shadow";
 if(gate.requested==="new"&&gate.parityProven===true&&
    gate.rollbackProven===true&&gate.releaseApproved===true)return "new";
 return "legacy";
}
export const legacyPriceWriterEnabled=(mode:ExperimentCutoverMode)=>
 mode!=="new";
export const newPriceWriterEnabled=(mode:ExperimentCutoverMode)=>
 mode==="new";
export const shadowPriceWriterEnabled=(_mode:ExperimentCutoverMode)=>false;
