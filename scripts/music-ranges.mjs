import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const target=process.argv[2];
const scratch=await mkdtemp(path.join(tmpdir(),'nongtrai-music-'));
const helper=fileURLToPath(new URL('./fetch-range.ps1',import.meta.url));
function ps(args){return new Promise((resolve,reject)=>{const child=spawn('pwsh',['-NoProfile','-File',helper,...args],{windowsHide:true});let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim()):reject(new Error(error)));});}
for(const name of ['bgm_dew_on_the_paddy-BYTG03e0.mp3','bgm_morning_in_the_bamboo_grove-DYMsrbBP.mp3']){
  const url=`https://nongtrai.jackle.dev/assets/${name}`;
  const length=Number(await ps(['-Url',url]));if(!length)throw new Error('Missing length');
  const size=262144,parts=Array.from({length:Math.ceil(length/size)},(_,i)=>({start:i*size,end:Math.min(length-1,(i+1)*size-1),file:path.join(scratch,`${name}.${i}`)}));
  let completed=0;
  for(let i=0;i<parts.length;i+=8)await Promise.all(parts.slice(i,i+8).map(async part=>{for(let retry=0;;retry++){try{await ps(['-Url',url,'-Destination',part.file,'-Start',String(part.start),'-End',String(part.end)]);const bytes=await readFile(part.file);if(bytes.length!==part.end-part.start+1)throw new Error('Invalid ranged byte count');break;}catch(e){if(retry>=2)throw e;}}completed++;console.log(`${name}: ${completed}/${parts.length} chunks`);}));
  const bytes=Buffer.concat(await Promise.all(parts.map(p=>readFile(p.file))));if(bytes.length!==length)throw new Error('Invalid assembled length');
  await writeFile(path.join(target,'public/assets',name),bytes);console.log(`Saved ${name}: ${bytes.length} bytes`);
}
