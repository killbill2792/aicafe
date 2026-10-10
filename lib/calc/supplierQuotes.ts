/** Comparable only when package units AND counts match. Never invent conversions. */
export function compareSupplierQuotePrices(
 a:{priceCents:number;packageUnit:string;packageCount:number},
 b:{priceCents:number;packageUnit:string;packageCount:number},
):{comparable:true;differenceCents:number}|{comparable:false;reason:"package_mismatch"|"invalid_price"}{
 if(![a.priceCents,b.priceCents,a.packageCount,b.packageCount].every(Number.isSafeInteger)
    ||a.priceCents<=0||b.priceCents<=0||a.packageCount<=0||b.packageCount<=0)
  return {comparable:false,reason:"invalid_price"};
 if(a.packageUnit!==b.packageUnit||a.packageCount!==b.packageCount)
  return {comparable:false,reason:"package_mismatch"};
 return {comparable:true,differenceCents:b.priceCents-a.priceCents};
}
