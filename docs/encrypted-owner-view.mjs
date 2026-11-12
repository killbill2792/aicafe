// Read-only GitHub Pages unlock: all sensitive fields stay encrypted until the
// owner supplies the passphrase in this browser. NEVER fetch the private ledger,
// request a GitHub token, write owner controls or persist the password.
const FILE='./encrypted-owner-snapshot.json';
const decode64=value=>{
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))
   throw Error('Invalid encrypted snapshot');
 return Uint8Array.from(atob(value),x=>x.charCodeAt(0));
};
export async function decryptOwnerEnvelope(e,password,cryptoImpl=globalThis.crypto){
 if(!cryptoImpl?.subtle||typeof password!=='string'||!password)
   throw Error('Secure browser and dashboard password required');
 if(e?.version!==1||e.kdf?.name!=='PBKDF2'||e.kdf?.hash!=='SHA-256'||
    e.kdf?.iterations!==600000||e.cipher?.name!=='AES-256-GCM')
   throw Error('Unsupported encrypted snapshot');
 const salt=decode64(e.kdf.salt),iv=decode64(e.cipher.iv),body=decode64(e.ciphertext);
 if(salt.length!==16||iv.length!==12||body.length<16||body.length>2_000_000)
   throw Error('Invalid encrypted snapshot');
 const base=await cryptoImpl.subtle.importKey('raw',new TextEncoder().encode(password),
   'PBKDF2',false,['deriveKey']);
 const key=await cryptoImpl.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',
   salt,iterations:e.kdf.iterations},base,{name:'AES-GCM',length:256},false,['decrypt']);
 let bytes;
 try{bytes=await cryptoImpl.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},
   key,body);}
 catch{throw Error('Wrong password or encrypted snapshot failed integrity checks');}
 let decoded;
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch{throw Error('Invalid decrypted task snapshot');}
 if(decoded?.version!==1||!Array.isArray(decoded.tasks)||
    decoded.tasks.length>5000)throw Error('Invalid decrypted task snapshot');
 return decoded;
}

const element=(tag,cls,text)=>{
 const e=document.createElement(tag);
 if(cls)e.className=cls;
 if(text!=null)e.textContent=String(text);
 return e;
};
function renderUnlocked(data){
 const box=document.querySelector('#encrypted-private-view');
 box.replaceChildren();
 const meta=element('p','meta',
   'Private ledger: '+(data.ledger_updated_at||'unknown')+
   ' · GitHub schedule: '+(data.last_schedule_at||'unknown')+
   ' · Pending owner notices: '+(data.owner_notices_pending??'unknown'));
 const age=Date.parse(data.last_schedule_at||'');
 const health=element('p','private-health',Number.isFinite(age)&&
   Date.now()-age<=15*60_000?'GitHub schedule observed recently':
   'GitHub schedule stale or unknown; displayed data may be outdated');
 const summary=element('p','meta',data.tasks.length+' tracked task rows · read-only');
 const wrap=element('div','table-scroll');
 const table=element('table','private-task-table');
 const thead=element('thead'),htr=element('tr');
 for(const col of ['Task','Stage','PR','CI','Codex','Acceptance','Dependencies','Merge','Integration','Next actor / action'])
   htr.append(element('th','',col));
 thead.append(htr);
 const tbody=element('tbody');
 for(const x of data.tasks){
   const tr=element('tr');
   tr.append(element('td','',String(x.product||'')+' / '+x.id));
   tr.append(element('td','',x.stage||'unknown'));
   const pr=element('td');
   if(x.pr?.number&&x.pr?.url===
     'https://github.com/killbill2792/aicafe/pull/'+x.pr.number){
     const a=element('a','',('#'+x.pr.number+' '+(x.pr.state||'')));
     a.href=x.pr.url;a.target='_blank';a.rel='noopener noreferrer';pr.append(a);
   }else pr.textContent=x.pr?.state||'missing';
   tr.append(pr,element('td','',x.ci||'unknown'),element('td','',x.codex||'unknown'),
     element('td','',x.acceptance||'unknown'),
     element('td','',(x.dependencies||[]).join(', ')||'none'),
     element('td','',x.merge_eligible?'Eligible':'Blocked'),
     element('td','',x.integration||'unknown'),
     element('td','',(x.next_actor||'unknown')+' · '+(x.next_action||'none')));
   tbody.append(tr);
 }
 table.append(thead,tbody);wrap.append(table);
 box.append(meta,health,summary,wrap);
 box.hidden=false;
}

export function initEncryptedOwnerView({fetchImpl=fetch}={}){
 const form=document.querySelector('#private-unlock-form');
 const password=document.querySelector('#private-passphrase');
 const lock=document.querySelector('#private-lock');
 const result=document.querySelector('#private-unlock-status');
 const panel=document.querySelector('#encrypted-private-view');
 if(!form||!password||!lock||!result||!panel)return;
 const clear=()=>{panel.replaceChildren();panel.hidden=true;password.value='';
   lock.hidden=true;form.hidden=false;result.textContent='Locked · private task data not loaded';};
 lock.addEventListener('click',clear);
 form.addEventListener('submit',async event=>{
   event.preventDefault();
   result.textContent='Decrypting private task snapshot…';
   const entered=password.value;
   password.value='';
   try{
     const response=await fetchImpl(FILE,{cache:'no-store'});
     if(!response.ok)throw Error('Encrypted snapshot not published yet (HTTP '+response.status+')');
     const envelope=await response.json();
     const decrypted=await decryptOwnerEnvelope(envelope,entered);
     renderUnlocked(decrypted);
     lock.hidden=false;form.hidden=true;
     result.textContent='Unlocked in this tab only. No changes can be made here.';
   }catch(error){clear();result.textContent=String(error.message).slice(0,160);}
 });
 clear();
}
