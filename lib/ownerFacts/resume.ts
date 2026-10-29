/** The next model turn must see the original request, not only a save toast. */
export function resumeOwnerQuestion(original:string|null,acknowledgement:string,
 answers:readonly {label:string;value:string}[]):string{
 const details=answers.map(answer=>answer.label+": "+answer.value).join("; ");
 return [original?.trim(),acknowledgement,details].filter(Boolean).join("\n");
}
