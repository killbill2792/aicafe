/**
 * 14D reconciliation uses independently authenticated, normalized SOURCE facts.
 * This is a pure comparison, never an authorization, stock/expense writer or
 * closure receipt. Upstream must resolve PO, supplier, line and source identity.
 * Quantities are canonical base units scaled by 10,000 (Pantry precision).
 * Money is integer café-currency cents. Never use a model guess as a fact.
 */
export type OrderLine={
 id:string;ingredientId:string;orderedBase4:number;subtotalCents:number;
};
export type OrderSnapshot={
 businessId:string;id:string;supplierId:string;currency:string;
 lines:readonly OrderLine[];
};
type ScopedDocument={
 businessId:string;purchaseOrderId:string;supplierId:string;
 // Stable semantic identity, not message ID, attachment hash or attempt ID.
 id:string;revision:number;
};
export type ReceivingDocument=ScopedDocument&{
 verifiedPhysicalReceipt:boolean;
 lines:readonly {id:string;orderLineId:string;ingredientId:string;
  receivedBase4:number;acceptedBase4:number;damagedBase4:number}[];
};
export type InvoiceDocument=ScopedDocument&{
 currency:string;subtotalCents:number;taxCents:number|null;
 freightCents:number|null;discountCents:number|null;totalCents:number;
 lines:readonly {id:string;orderLineId:string;ingredientId:string;
  quantityBase4:number;subtotalCents:number}[];
};
export type ReconciliationIssue=
 "invalid_order"|"ambiguous_revision"|"unresolved_identity"|"physical_receipt_unverified"|
 "invalid_receipt"|"incorrect_product"|"damaged_goods"|"short_delivery"|"excess_delivery"|
 "invalid_invoice"|"invoice_currency_mismatch"|"invoice_price_difference"|
 "invoice_total_difference"|"invoice_charges_unknown"|"invoice_quantity_difference"|
 "invoice_not_received"|"invoice_missing";
const whole=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const positive=(n:number)=>whole(n)&&n>0;
const add=(a:number,b:number):number|null=>whole(a)&&whole(b)&&whole(a+b)?a+b:null;
const unique=(ids:readonly string[])=>ids.every(Boolean)&&new Set(ids).size===ids.length;
// Stable source tuple comparison. Field order in incoming JSON is immaterial.
const stable=(v:unknown):string=>{
 if(v===null||typeof v!=="object")return JSON.stringify(v)??"undefined";
 if(Array.isArray(v))return "["+v.map(stable).join(",")+"]";
 const entries=Object.entries(v).sort(([a],[b])=>a.localeCompare(b));
 return "{"+entries.map(([k,value])=>JSON.stringify(k)+":"+stable(value)).join(",")+"}";
};
function current<T extends ScopedDocument>(docs:readonly T[],order:OrderSnapshot,
 issues:Set<ReconciliationIssue>):T[]{
 const groups=new Map<string,T[]>();
 for(const doc of docs){
  if(doc.businessId!==order.businessId||doc.purchaseOrderId!==order.id||
     doc.supplierId!==order.supplierId||!doc.id||!positive(doc.revision)){
   issues.add("unresolved_identity");continue;
  }
  const revisions=groups.get(doc.id)??[];
  revisions.push(doc);groups.set(doc.id,revisions);
 }
 const result:T[]=[];
 for(const revisions of groups.values()){
  // Conflicting contents under ANY one revision are not a trustworthy history.
  const versions=new Map<number,string>();let conflict=false;
  for(const doc of revisions){
   const fingerprint=stable(doc);
   if(versions.has(doc.revision)&&versions.get(doc.revision)!==fingerprint)conflict=true;
   versions.set(doc.revision,fingerprint);
  }
  if(conflict){issues.add("ambiguous_revision");continue;}
  result.push(revisions.reduce((a,b)=>a.revision>=b.revision?a:b));
 }
 return result;
}
export function reconcilePurchaseOrder(order:OrderSnapshot,
 receipts:readonly ReceivingDocument[],invoices:readonly InvoiceDocument[]){
 const issues=new Set<ReconciliationIssue>();
 const validOrder=Boolean(order.businessId&&order.id&&order.supplierId&&
  /^[A-Z]{3}$/.test(order.currency)&&order.lines.length&&unique(order.lines.map(l=>l.id))&&
  order.lines.every(l=>l.ingredientId&&positive(l.orderedBase4)&&whole(l.subtotalCents)));
 const result=order.lines.map(l=>({orderLineId:l.id,ingredientId:l.ingredientId,
  orderedBase4:l.orderedBase4,verifiedReceivedBase4:0,acceptedBase4:0,damagedBase4:0,
  invoicedBase4:0,outstandingBase4:l.orderedBase4}));
 const byId=new Map(result.map((l,i)=>[l.orderLineId,{row:l,orderLine:order.lines[i]}]));
 let invoiceTotalCents:number|null=0;
 const summary=()=>({currency:order.currency,lines:validOrder?result:[],
  // Zero verified invoices is NOT a statement that no invoices exist.
  verifiedInvoiceTotalCents:invoiceTotalCents,
  issues:[...issues],matchingEvidence:issues.size===0,
  // Only the effect/receipt verification layer may determine closure/payability.
  closureVerified:false as const,payableCents:null,paidCents:null});
 if(!validOrder){issues.add("invalid_order");invoiceTotalCents=null;return summary();}
 for(const doc of current(receipts,order,issues)){
  if(!doc.verifiedPhysicalReceipt){issues.add("physical_receipt_unverified");continue;}
  if(!doc.lines.length||!unique(doc.lines.map(l=>l.id))){
   issues.add("invalid_receipt");continue;
  }
  for(const line of doc.lines){
   const found=byId.get(line.orderLineId);
   if(!found||line.ingredientId!==found.orderLine.ingredientId){
    issues.add("incorrect_product");continue;
   }
   const quantities=add(line.acceptedBase4,line.damagedBase4);
   if(!(doc.revision>1?whole(line.receivedBase4):positive(line.receivedBase4))||quantities!==line.receivedBase4){
    issues.add("invalid_receipt");continue;
   }
   const row=found.row;
   const received=add(row.verifiedReceivedBase4,line.receivedBase4);
   const accepted=add(row.acceptedBase4,line.acceptedBase4);
   const damaged=add(row.damagedBase4,line.damagedBase4);
   if(received===null||accepted===null||damaged===null){
    issues.add("invalid_receipt");continue;
   }
   row.verifiedReceivedBase4=received;row.acceptedBase4=accepted;row.damagedBase4=damaged;
   if(line.damagedBase4>0)issues.add("damaged_goods");
  }
 }
 const currentInvoices=current(invoices,order,issues);
 if(!currentInvoices.length){issues.add("invoice_missing");invoiceTotalCents=null;}
 for(const invoice of currentInvoices){
  if(invoice.currency!==order.currency){
   issues.add("invoice_currency_mismatch");invoiceTotalCents=null;continue;
  }
  if(!whole(invoice.subtotalCents)||!whole(invoice.totalCents)||
     !invoice.lines.length||!unique(invoice.lines.map(l=>l.id))||
     !invoice.lines.every(l=>positive(l.quantityBase4)&&whole(l.subtotalCents))){
   issues.add("invalid_invoice");invoiceTotalCents=null;continue;
  }
  let subtotal:number|null=0;
  for(const line of invoice.lines)subtotal=subtotal===null?null:add(subtotal,line.subtotalCents);
  if(subtotal!==invoice.subtotalCents){
   issues.add("invoice_total_difference");invoiceTotalCents=null;continue;
  }
  const {taxCents,freightCents,discountCents}=invoice;
  if(taxCents===null||freightCents===null||discountCents===null){
   issues.add("invoice_charges_unknown");invoiceTotalCents=null;
  }else if(!whole(taxCents)||!whole(freightCents)||!whole(discountCents)||
    BigInt(invoice.subtotalCents)+BigInt(taxCents)+BigInt(freightCents)-
    BigInt(discountCents)!==BigInt(invoice.totalCents)){
   issues.add("invoice_total_difference");invoiceTotalCents=null;
  }else if(invoiceTotalCents!==null){
   invoiceTotalCents=add(invoiceTotalCents,invoice.totalCents);
   if(invoiceTotalCents===null)issues.add("invalid_invoice");
  }
  for(const line of invoice.lines){
   const found=byId.get(line.orderLineId);
   if(!found||line.ingredientId!==found.orderLine.ingredientId){
    issues.add("incorrect_product");continue;
   }
   const {row,orderLine}=found;
   const quantity=add(row.invoicedBase4,line.quantityBase4);
   if(quantity===null){issues.add("invalid_invoice");continue;}
   row.invoicedBase4=quantity;
   // Compare prorated PO value in exact integer arithmetic, round only once
   // to the nearest cent (half up). No floating point money or guessed price.
   const denominator=BigInt(orderLine.orderedBase4);
   const numerator=BigInt(orderLine.subtotalCents)*BigInt(line.quantityBase4);
   const expected=(BigInt(2)*numerator+denominator)/(BigInt(2)*denominator);
   if(expected!==BigInt(line.subtotalCents))issues.add("invoice_price_difference");
  }
 }
 for(const row of result){
  row.outstandingBase4=Math.max(0,row.orderedBase4-row.acceptedBase4);
  if(row.outstandingBase4>0)issues.add("short_delivery");
  if(row.verifiedReceivedBase4>row.orderedBase4)issues.add("excess_delivery");
  if(row.invoicedBase4!==row.acceptedBase4)issues.add("invoice_quantity_difference");
  if(row.invoicedBase4>row.acceptedBase4)issues.add("invoice_not_received");
 }
 // Any conflicting identity leaves the aggregate invoice total incomplete.
 if(issues.has("ambiguous_revision")||issues.has("unresolved_identity"))invoiceTotalCents=null;
 return summary();
}
