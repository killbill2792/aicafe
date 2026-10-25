/** Pure safe integer cost arithmetic; model and UI never calculate business values. */
export function safeDifferenceCents(left:number,right:number):number|null{
 if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right))return null;
 const result=left-right;
 return Number.isSafeInteger(result)?result:null;
}
export function safeSumCents(values:readonly number[]):number|null{
 if(values.some(x=>!Number.isSafeInteger(x)))return null;
 const sum=values.reduce((a,b)=>a+b,0);
 return Number.isSafeInteger(sum)?sum:null;
}
