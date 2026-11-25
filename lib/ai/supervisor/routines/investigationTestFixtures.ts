/** Test-only SQL executor receipt fixtures. No production adapter or reporting route. */
export function sqlObservation(relation:string,row:Record<string,unknown>|null,column_units:Record<string,string>={}){
 const rows=row?[row]:[];
 return {name:"query_data",result:{source:"u3_canonical_research",period:null as {from:string;to:string}|null,missing:[] as string[],
  truncated:false,empty:rows.length===0,rows,rowCount:rows.length,evidence:{
   scope:"verified_owner_cafe_lease",receipt_id:"11111111-1111-4111-8111-111111111111",
   query_fingerprint:"a".repeat(64),catalog_version:"b".repeat(16),relation_names:[relation],column_units,
   column_origins:Object.fromEntries(Object.keys(row??{}).map(column=>[column,{relation,column,binding:1}]))
  }}};
}
export function failedSqlObservation(reason:string){
 const empty=sqlObservation("daily_rollups",null);
 return {...empty,result:{...empty.result,error:reason,missing:[reason]}};
}
