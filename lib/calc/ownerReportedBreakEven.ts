/** Convert an explicitly owner-supplied percentage into exact integer basis points. */
export function percentToBasisPoints(percent:number|null|undefined):number|null{
  if(percent===null||percent===undefined)return null;
  if(!Number.isFinite(percent)||percent<0||percent>=100)return null;
  const basisPoints=Math.round(percent*100);
  return Number.isSafeInteger(basisPoints)?basisPoints:null;
}

/** Average recorded fixed labor and operating costs over the covered calendar days.
 * Never infer a zero for missing inputs. Caller verifies source coverage first. */
export function recordedDailyFixedCosts(input:{
  loadedStaffCents:number;
  runningCostsCents:number;
  expectedDays:number;
}):number|null{
  const {loadedStaffCents,runningCostsCents,expectedDays}=input;
  if(!Number.isSafeInteger(loadedStaffCents)||loadedStaffCents<0||
    !Number.isSafeInteger(runningCostsCents)||runningCostsCents<0||
    !Number.isSafeInteger(expectedDays)||expectedDays<=0)return null;
  const total=loadedStaffCents+runningCostsCents;
  if(!Number.isSafeInteger(total))return null;
  const daily=Math.round(total/expectedDays);
  return Number.isSafeInteger(daily)?daily:null;
}

/** Owner figures are assumptions, not POS observations. Monetary arithmetic stays in cents. */
export function ownerReportedDailyBreakEven(input: {
  dailyFixedCostsCents: number;
  ingredientPackagingBps: number;
  /** Null means the result explicitly excludes processing fees. */
  processingFeeBps?: number | null;
  netSalesCents?: number | null;
  salesDays?: number | null;
}) {
  const { dailyFixedCostsCents, ingredientPackagingBps, netSalesCents, salesDays } = input;
  const processingFeeBps=input.processingFeeBps??null;
  if (!Number.isSafeInteger(dailyFixedCostsCents) || dailyFixedCostsCents < 0 ||
      !Number.isSafeInteger(ingredientPackagingBps) ||
      ingredientPackagingBps < 0 || ingredientPackagingBps >= 10000 ||
      (processingFeeBps!==null&&(!Number.isSafeInteger(processingFeeBps)||processingFeeBps<0||processingFeeBps>=10000)))
    return null;
  const contributionBps = 10000 - ingredientPackagingBps - (processingFeeBps??0);
  if(contributionBps<=0)return null;
  // Use exact integer division: multiplying a large but safe cents value
  // by 10,000 in Number space can silently lose precision before rounding.
  const needed=(BigInt(dailyFixedCostsCents)*BigInt(10000)+
    BigInt(contributionBps)-BigInt(1))/BigInt(contributionBps);
  if(needed>BigInt(Number.MAX_SAFE_INTEGER))return null;
  const dailyBreakEvenSalesCents=Number(needed);
  const dailyNetSalesCents = netSalesCents !== null && netSalesCents !== undefined &&
    Number.isSafeInteger(netSalesCents) && netSalesCents >= 0 &&
    salesDays !== null && salesDays !== undefined &&
    Number.isSafeInteger(salesDays) && salesDays > 0
      ? Math.round(netSalesCents / salesDays) : null;
  return {
    dailyFixedCostsCents, contributionBps, dailyBreakEvenSalesCents,
    processingFeeBps,processingFeesIncluded:processingFeeBps!==null,
    dailyNetSalesCents,
    dailyShortfallCents: dailyNetSalesCents === null ? null :
      dailyBreakEvenSalesCents - dailyNetSalesCents,
  };
}
