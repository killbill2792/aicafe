/** All money is integer cents; no provider amount is inferred from missing fields. */
export type ToastReconciliationInput={
 importedNetSalesCents:number;analyticsNetSalesCents:number;
 importedOrderCount:number;analyticsOrderCount:number;
 importedDiscountCents:number;analyticsDiscountCents:number;
 importedRefundCents:number;analyticsRefundCents:number;
 importedVoidOrderCount:number;analyticsVoidOrderCount:number;
 toleranceCents:number;
};
export function compareToastAnalytics(p:ToastReconciliationInput){
 const values=Object.values(p);
 if(!values.every(Number.isSafeInteger)||p.toleranceCents<0)
  throw new Error("Invalid Toast money/count comparison");
 const deltaNetCents=p.analyticsNetSalesCents-p.importedNetSalesCents;
 const deltaOrders=p.analyticsOrderCount-p.importedOrderCount;
 const deltaDiscountCents=p.analyticsDiscountCents-p.importedDiscountCents;
 const deltaRefundCents=p.analyticsRefundCents-p.importedRefundCents;
 const deltaVoidOrders=p.analyticsVoidOrderCount-p.importedVoidOrderCount;
 const matched=Math.abs(deltaNetCents)<=p.toleranceCents&&deltaOrders===0&&
  deltaVoidOrders===0;
 return {matched,deltaNetCents,deltaOrders,deltaDiscountCents,
  deltaRefundCents,deltaVoidOrders};
}
export function checkToastPaymentBalance(checkAmountCents:number|null,
 taxCents:number|null,gratuityCents:number|null,
 paymentsCents:ReadonlyArray<number|null>,toleranceCents=1){
 const known=[checkAmountCents,taxCents,gratuityCents,...paymentsCents];
 if(known.some(n=>n==null||!Number.isSafeInteger(n)))return "unknown" as const;
 const expected=(checkAmountCents as number)+(taxCents as number)+(gratuityCents as number);
 const paid=paymentsCents.reduce<number>((total,n)=>total+(n as number),0);
 return Math.abs(expected-paid)<=toleranceCents?"matched" as const:"mismatch" as const;
}

/** Toast selection.price is already net of item and check discounts. */
export function checkToastSelectionBalance(
 checkAmountCents:number|null,selectionsCents:ReadonlyArray<number|null>,
 serviceCents:ReadonlyArray<number|null>,
 toleranceCents=1
){
 const parts=[checkAmountCents,...selectionsCents,...serviceCents];
 if(parts.some(n=>n==null||!Number.isSafeInteger(n)))return "unknown" as const;
 const sum=(ns:ReadonlyArray<number|null>)=>ns.reduce<number>((a,n)=>a+(n as number),0);
 const expected=sum(selectionsCents)+sum(serviceCents);
 return Math.abs(expected-(checkAmountCents as number))<=toleranceCents
  ?"matched" as const:"mismatch" as const;
}
