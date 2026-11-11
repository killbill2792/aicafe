// The existing owner-control issue is the public source for scope proposals.
// A snapshot is complete only after GitHub's final (short) page is read.
// Never silently skip an early plan merely because newer comments arrived.
export async function fetchScopeComments(github,issue) {
 if(!Number.isSafeInteger(issue)||issue<=0)throw Error('Invalid scope issue');
 const rows=[],seen=new Set();
 for(let page=1;;page++) {
  const chunk=await github.request('/issues/'+issue+
   '/comments?per_page=100&page='+page);
  if(!Array.isArray(chunk)||chunk.length>100)
   throw Error('Invalid GitHub scope comment page '+page);
  let advanced=false;
  for(const comment of chunk) {
   if(!Number.isSafeInteger(comment?.id)||seen.has(comment.id))
    throw Error('Repeated or invalid scope comment ID on page '+page);
   seen.add(comment.id);
   rows.push(comment);
   advanced=true;
  }
  if(chunk.length<100)return rows;
  if(!advanced)throw Error('Scope pagination made no progress');
 }
}
