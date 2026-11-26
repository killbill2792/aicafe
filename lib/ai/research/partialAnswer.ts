/** Last-resort owner text when research ran out of time or budget before the model wrote an answer.
 * It only restates retrieved evidence and says plainly what is unfinished; it never invents a figure. */
const clip=(raw:string,max:number)=>raw.length>max?raw.slice(0,max)+"…":raw;
export function partialAnswerFromEvidence(evidence:readonly string[]):string{
  const found=evidence.filter(e=>e&&e.trim()).slice(-3);
  if(!found.length)return "";
  return "I ran out of time before I could finish this answer, so here is what I retrieved so far. It is not a complete answer, and any part of your question not covered below is still unanswered. Ask me to continue and I will pick up from here.\n\n"+
    found.map(e=>"```json\n"+clip(e,1500)+"\n```").join("\n\n");
}
