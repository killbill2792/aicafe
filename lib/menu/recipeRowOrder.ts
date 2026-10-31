/** Pure, per-size recipe display order. Ingredient IDs are the stable identities;
 * quantity/unit/cost values are never transformed by an ordering operation. */
export function moveRecipeRow(order:readonly string[],id:string,direction:-1|1):string[]{
 const index=order.indexOf(id),next=index+direction;
 if(index<0||next<0||next>=order.length)return [...order];
 const result=[...order];[result[index],result[next]]=[result[next],result[index]];
 return result;
}

export function insertRecipeRowAfter<T extends {ingredientId:string}>(
 rows:readonly T[],newRow:T,after:string,originalId?:(row:T)=>string
):T[]{
 if(rows.some(row=>row.ingredientId===newRow.ingredientId))return [...rows];
 const index=after==="top"?-1:rows.findIndex(row=>(originalId?.(row)??row.ingredientId)===after);
 const result=[...rows];result.splice(index<0&&after!=="top"?result.length:index+1,0,newRow);
 return result;
}
