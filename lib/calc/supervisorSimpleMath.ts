/** Pure exact-cents arithmetic for short conversational what-if requests.
 * The AI selects an operation; the server binds source values and recomputes it.
 * No float math, model-authored result, SQL or arbitrary code is executed.
 */
export type SimpleOperation="add"|"subtract"|"multiply"|"divide"|"percent_increase"|"percent_decrease";
export type SimpleUnit="USD_cents"|"count"|"ratio_bps";
export type SimpleOperand={value:number;unit:SimpleUnit};

function roundHalfUp(n:bigint,d:bigint):bigint{
  if(d<=0n)throw new Error("Invalid divisor");
  const sign=n<0n?-1n:1n,positive=n<0n?-n:n;
  return sign*((positive*2n+d)/(2n*d));
}
function safe(n:bigint):number|null{
  return n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(-Number.MAX_SAFE_INTEGER)?Number(n):null;
}
export function calculateSimple(op:SimpleOperation,a:SimpleOperand,b:SimpleOperand):
  {value:number;unit:SimpleUnit}|null{
  if(!Number.isSafeInteger(a.value)||!Number.isSafeInteger(b.value))return null;
  const x=BigInt(a.value),y=BigInt(b.value);
  if(op==="add"||op==="subtract"){
    if(a.unit!==b.unit)return null;
    const value=safe(op==="add"?x+y:x-y);
    return value===null?null:{value,unit:a.unit};
  }
  if(op==="multiply"){
    if(a.unit!=="USD_cents"||b.unit!=="count"||b.value<0)return null;
    const value=safe(x*y);
    return value===null?null:{value,unit:"USD_cents"};
  }
  if(op==="divide"){
    if(a.unit!=="USD_cents"||!["count","ratio_bps"].includes(b.unit)||y<=0n)return null;
    const value=safe(roundHalfUp(x*(b.unit==="ratio_bps"?10000n:1n),y));
    return value===null?null:{value,unit:"USD_cents"};
  }
  if(a.unit!=="USD_cents"||b.unit!=="ratio_bps"||y<0n||y>1000000n)return null;
  const delta=roundHalfUp(x*y,10000n);
  const value=safe(op==="percent_increase"?x+delta:x-delta);
  return value===null?null:{value,unit:"USD_cents"};
}
/** The caller must establish the full quoted span occurs in authenticated owner text. */
export function parseQuotedOperand(quote:string):SimpleOperand|null{
  const s=quote.trim();
  const money=/^\$([0-9]{1,9})(?:\.([0-9]{1,2}))?$/u.exec(s);
  if(money)return {value:Number(money[1])*100+Number((money[2]??"").padEnd(2,"0")),unit:"USD_cents"};
  const cents=/^([0-9]{1,9})(?:\.([0-9]{1,2}))?\s*cents?$/iu.exec(s);
  if(cents)return {value:Number(cents[1])*100+Number((cents[2]??"").padEnd(2,"0")),unit:"USD_cents"};
  const percent=/^([0-9]{1,4})(?:\.([0-9]{1,2}))?%$/u.exec(s);
  if(percent)return {value:Number(percent[1])*100+Number((percent[2]??"").padEnd(2,"0")),unit:"ratio_bps"};
  const count=/^([0-9]{1,9})$/u.exec(s);
  return count?{value:Number(count[1]),unit:"count"}:null;
}
export function quoteAppearsInOwnerText(quote:string,ownerText:string):boolean{
  const start=ownerText.indexOf(quote);
  if(start<0)return false;
  const isWord=(c:string)=>/[\p{L}\p{N}]/u.test(c);
  return !isWord(ownerText[start-1]??"")&&!isWord(ownerText[start+quote.length]??"");
}
