/** Conservative Unicode whole-entity matching. A longer concurrently matched
 * canonical name shadows its shorter constituent (e.g. oat vs oat milk). */
const canonical=(s:string)=>s.normalize("NFKC").toLocaleLowerCase()
  .replace(/\s+/gu," ").trim();
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function phraseInGoal(goal:string,name:string):boolean{
  const normalized=canonical(name);
  if(!normalized)return false;
  const pattern=new RegExp("(?<![\\p{L}\\p{N}])"+escape(normalized)+
    "(?![\\p{L}\\p{N}])","u");
  return pattern.test(canonical(goal));
}
export function ownerMentionsNamedEntity(
  goal:string,name:string,knownNames:readonly string[]=[],
):boolean{
  if(!phraseInGoal(goal,name))return false;
  const target=canonical(name);
  return !knownNames.some(other=>{
    const longer=canonical(other);
    return longer.length>target.length&&phraseInGoal(longer,target)&&
      phraseInGoal(goal,longer);
  });
}
