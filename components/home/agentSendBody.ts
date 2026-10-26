export function buildAgentSendBody(clientMessageId:string,text:string,locale:"en"|"es"|"ar",attachments:readonly {id:string;mediaType:string}[]){
 return {clientMessageId,text,locale,attachmentIds:attachments.filter(file=>["image/jpeg","image/png","image/webp"].includes(file.mediaType)).slice(0,3).map(file=>file.id)};
}