const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.argv[2]||path.resolve(__dirname,'../public'));
const files=[];
function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const name=path.join(directory,entry.name);entry.isDirectory()?walk(name):files.push(name);}}
walk(root);
const missing=new Map(),invalidGlbs=[],externalGlbUris=[];
function asset(raw,source){
  if(!raw||raw.includes('..')||raw.startsWith('data:')||raw.includes('${'))return;
  let pathname;
  if(raw.startsWith('/assets/'))pathname=raw;
  else if(raw.startsWith('assets/'))pathname='/'+raw;
  else if(raw.startsWith('./')&&/\.(js|css)$/.test(raw))pathname='/'+path.posix.join(path.posix.dirname('/'+path.relative(root,source).replaceAll('\\','/')),raw);
  else if(raw.startsWith('/icons/'))pathname=raw;
  else return;
  pathname=pathname.replace(/^\/\//,'/');
  if(!fs.existsSync(path.join(root,pathname.slice(1))))missing.set(pathname,path.relative(root,source));
}
for(const file of files){
  if(/\.(js|css|html|webmanifest|json)$/i.test(file)){
    const text=fs.readFileSync(file,'utf8');
    for(const m of text.matchAll(/["'`](\/?(?:assets|icons)\/[^"'`\s<>]+)["'`]/g))asset(m[1],file);
    for(const m of text.matchAll(/["'](\.\/[^"'\s]+\.(?:js|css))["']/g))asset(m[1],file);
    if(/\.css$/.test(file))for(const m of text.matchAll(/url\(["']?([^"'\s)]+)["']?\)/g))asset(m[1],file);
  }
  if(/\.glb$/.test(file)){
    const bytes=fs.readFileSync(file);
    if(bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(8)!==bytes.length){invalidGlbs.push(path.relative(root,file));continue;}
    let offset=12;
    while(offset+8<=bytes.length){const length=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);if(type===0x4e4f534a){const json=JSON.parse(bytes.subarray(offset+8,offset+8+length).toString('utf8'));for(const item of [...json.buffers||[],...json.images||[]])if(item.uri&&!item.uri.startsWith('data:')){const target=path.resolve(path.dirname(file),item.uri);externalGlbUris.push({file:path.relative(root,file),uri:item.uri,exists:fs.existsSync(target)});if(!fs.existsSync(target))missing.set('/'+path.relative(root,target).replaceAll('\\','/'),path.relative(root,file));}}offset+=8+length;}
  }
}
const emptyFiles=files.filter(file=>fs.statSync(file).size===0).map(file=>path.relative(root,file));
const report={files:files.length,bytes:files.reduce((n,file)=>n+fs.statSync(file).size,0),counts:Object.fromEntries([...new Set(files.map(file=>path.extname(file)))].map(ext=>[ext,files.filter(file=>path.extname(file)===ext).length])),missing:[...missing].map(([asset,source])=>({asset,source})),emptyFiles,invalidGlbs,externalGlbUris};
console.log(JSON.stringify(report,null,2));
if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));
if(missing.size||emptyFiles.length||invalidGlbs.length)process.exitCode=1;
