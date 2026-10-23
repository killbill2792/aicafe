export type CostShift = {
  employeeId: string; date: string; start: string; end: string;
  overnight?: boolean; breakMinutes: number; wageCents: number | null;
  role?: string | null;
};
export type CostLine = CostShift & {
  minutes: number; paidMinutes: number; costCents: number | null;
  estimated: boolean; unknown: boolean;
};
export function minuteOfDay(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("invalid_time");
  const [h,m] = value.split(":").map(Number);
  return h * 60 + m;
}
export function elapsedMinutes(start: string, end: string, overnight = false): number {
  const a = minuteOfDay(start), b = minuteOfDay(end);
  const duration = b - a + (overnight ? 1440 : 0);
  if (duration <= 0 || duration > 1440) throw new Error("invalid_shift_length");
  return duration;
}
export function paidMinutes(shift: Pick<CostShift,"start"|"end"|"overnight"|"breakMinutes">): number {
  const length = elapsedMinutes(shift.start,shift.end,shift.overnight);
  if (!Number.isInteger(shift.breakMinutes) || shift.breakMinutes < 0 || shift.breakMinutes > Math.min(240,length))
    throw new Error("invalid_break");
  return length - shift.breakMinutes;
}
/** Estimates are explicitly identified; no wage source means unknown, not free labor. */
export function shiftCost(shift: CostShift, roleAverageCents: number | null = null,
  businessDefaultCents: number | null = null): CostLine {
  const minutes = elapsedMinutes(shift.start,shift.end,shift.overnight);
  const worked = paidMinutes(shift);
  const actual = shift.wageCents != null && shift.wageCents > 0 ? shift.wageCents : null;
  const estimate = roleAverageCents && roleAverageCents > 0 ? roleAverageCents :
    businessDefaultCents && businessDefaultCents > 0 ? businessDefaultCents : null;
  const effective = actual ?? estimate;
  return {...shift,minutes,paidMinutes:worked,
    costCents:effective === null ? null : Math.round(worked*effective/60),
    estimated:actual === null,unknown:effective === null};
}
export function aggregateCosts(lines: CostLine[]) {
  return {
    paidMinutes:lines.reduce((n,l)=>n+l.paidMinutes,0),
    knownCostCents:lines.reduce((n,l)=>n+(l.costCents??0),0),
    estimateCount:lines.filter(l=>l.estimated&&!l.unknown).length,
    unknownCount:lines.filter(l=>l.unknown).length,
    estimated:lines.some(l=>l.estimated),
  };
}
export function roleWageAverages(people: {role:string|null;wageCents:number|null}[]) {
  const grouped = new Map<string,{sum:number;count:number}>();
  for(const p of people) if(p.role && p.wageCents && p.wageCents>0) {
    const k=p.role.toLocaleLowerCase(), prior=grouped.get(k)??{sum:0,count:0};
    grouped.set(k,{sum:prior.sum+p.wageCents,count:prior.count+1});
  }
  return new Map([...grouped].map(([key,v])=>[key,Math.round(v.sum/v.count)]));
}

/** Business-wide last-resort average is explicitly estimated, never canonical pay. */
export function businessWageEstimate(people:{wageCents:number|null}[]):number|null{
 const known=people.map(person=>person.wageCents).filter((n):n is number=>n!==null&&n>0);
 return known.length?Math.round(known.reduce((sum,n)=>sum+n,0)/known.length):null;
}

/** Report unknown compensation as missing data, not a complete total. */
export function missingWageInputs(total:{unknownCount:number}):string[]{
 return total.unknownCount>0?["wagesUnknownForSomeShifts"]:[];
}
/** A known subtotal with missing wages is not a complete labor total. */
export function costCompleteness(total:{knownCostCents:number;unknownCount:number}):"complete"|"partial"|"unknown"{
 if(total.unknownCount===0)return "complete";
 return total.knownCostCents===0?"unknown":"partial";
}
