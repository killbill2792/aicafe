/** The next model turn must see the original request, not only a save toast. */
export function resumeOwnerQuestion(original:string|null,acknowledgement:string,
 answers:readonly {label:string;value:string}[]):string{
 const details=answers.map(answer=>answer.label+": "+answer.value).join("; ");
 return [original?.trim(),acknowledgement,details].filter(Boolean).join("\n");
}
/** What the owner sees after answering a card. Nothing kept means the answers were
 * for this question only (or forgotten); never claim a save that did not happen. */
export function ownerAnswerAcknowledgement(
 result:{writeThroughApplied:boolean;remembered?:number;forgotten?:number},
 copy:{saved:string;savedBut:string;usedOnce:string;forgotten:string}):string{
 if(result.remembered===0)return (result.forgotten??0)>0?copy.forgotten:copy.usedOnce;
 return result.writeThroughApplied?copy.saved:copy.savedBut;
}
