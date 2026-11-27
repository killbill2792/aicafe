/** Shared, data-only display adaptation. Keep authored scalars exact, and
 * retain nested values as JSON text rather than making up a number. */
export type TableCell=string|number|boolean|null;
export const displayTableCell=(value:unknown):TableCell=>value==null?null:typeof value==="string"||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)?value:JSON.stringify(value)??String(value);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
export function normalizeTableData(columns:unknown,rows:readonly unknown[]):{columns:string[];rows:TableCell[][]}{
 const labels=Array.isArray(columns)?columns.map((value,index)=>String(displayTableCell(value)??"Value "+(index+1))||"Value "+(index+1)):[];
 // Named records are mapped by key, never insertion order or guessed labels.
 const keys=[...new Set(rows.flatMap(row=>record(row)?Object.keys(row):[]))];
 for(const key of keys)if(!labels.includes(key))labels.push(key);
 const cells=rows.map(row=>Array.isArray(row)?row.map(displayTableCell):record(row)?labels.map(key=>Object.hasOwn(row,key)?displayTableCell(row[key]):null):[displayTableCell(row)]);
 const width=cells.reduce((n,row)=>Math.max(n,row.length),Math.max(1,labels.length));
 return {columns:Array.from({length:width},(_,i)=>labels[i]??"Value "+(i+1)),rows:cells.map(row=>Array.from({length:width},(_,i)=>row[i]??null))};
}
