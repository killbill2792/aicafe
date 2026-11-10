import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {settings} from './settings.mjs';
export async function loadQueue({github,config=settings,readLocal=readFileSync}={}){
 const source=config.queue;
 if(source.repo===config.repo)return JSON.parse(readLocal(resolve(process.cwd(),source.path),'utf8'));
 const url='https://api.github.com/repos/'+source.repo+'/contents/'+
  source.path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(source.ref);
 const file=await github.request(url);
 if(file.type!=='file'||file.encoding!=='base64'||typeof file.content!=='string')
  throw Error('External queue is missing or not a JSON file: '+source.repo+'/'+source.path);
 const data=Buffer.from(file.content.replace(/\s/g,''),'base64');
 if(data.length>400000)throw Error('External task plan too large');
 const parsed=JSON.parse(data.toString('utf8'));
 if(!Array.isArray(parsed.tasks))throw Error('External queue missing signed tasks');
 return parsed;
}
