/** A supplier email is composed only from the saved, immutable, owner-approved
 * purchase order. No model-supplied quantity, price, shipping or tax. */
export type VendorOrderLine={
 itemName:string;packs:number;packQuantity:number;packUnit:string;lineSubtotalCents:number;
};
export type VendorOrderSnapshot={
 id:string;supplierName:string;currency:string;subtotalCents:number;
 neededBy:string|null;lines:VendorOrderLine[];
};
const safe=(value:string)=>value.replace(/[\r\n\t]+/gu," ").trim();
export function formatVendorMoney(cents:number,currency:string):string{
 if(!Number.isSafeInteger(cents)||cents<0||!/^[A-Z]{3}$/u.test(currency))
   throw new Error("vendor_order_currency_or_amount_invalid");
 return new Intl.NumberFormat("en",{style:"currency",currency}).format(cents/100);
}
export function buildVendorOrderEmail(order:VendorOrderSnapshot):{subject:string;body:string}{
 if(!/^[a-f\d-]{36}$/iu.test(order.id)||!order.lines.length||order.lines.length>10)
   throw new Error("vendor_order_snapshot_invalid");
 if(!order.lines.every(line=>line.packs>0&&Number.isSafeInteger(line.packs)&&
   line.packQuantity>0&&Number.isSafeInteger(line.packQuantity)&&
   Number.isSafeInteger(line.lineSubtotalCents)&&line.lineSubtotalCents>0))
   throw new Error("vendor_order_line_invalid");
 const sum=order.lines.reduce((total,line)=>total+line.lineSubtotalCents,0);
 if(!Number.isSafeInteger(sum)||sum!==order.subtotalCents)
   throw new Error("vendor_order_subtotal_mismatch");
 const supplier=safe(order.supplierName);
 const title="Purchase order "+order.id;
 const lines=order.lines.map((line,index)=>
   String(index+1)+". "+safe(line.itemName)+" — "+line.packs+" pack(s) of "+
   line.packQuantity+" "+safe(line.packUnit)+" — "+formatVendorMoney(line.lineSubtotalCents,order.currency));
 const body=[
   "Hello "+supplier+",","",
   "Please review the following purchase order from our café.",
   "Purchase order ID: "+order.id,
   "Currency: "+order.currency,
   ...(order.neededBy?["Requested delivery date: "+order.neededBy]:["Delivery date: please confirm"]),
   "","Items:",...lines,"",
   "Approved item subtotal: "+formatVendorMoney(order.subtotalCents,order.currency),
   "Shipping and tax have not been confirmed; this is not an agreed final total.",
   "","Please reply to confirm availability, delivery date, freight/tax and whether you accept this order.",
   "Do not substitute items or change quantities without checking with us.","","Thank you."
 ].join("\n");
 return {subject:title,body};
}
