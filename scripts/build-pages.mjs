import path from 'node:path';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const settings=JSON.parse(await readFile(path.join(root,'config/pages.json'),'utf8'));
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
let base=option('--base',settings.base);
if(!base.startsWith('/')||!base.endsWith('/')||base.includes('..'))throw new Error('Pages base must start and end with a slash.');
const origin=option('--origin',settings.origin);
const siteUrl=new URL(base,origin).href;
const output=path.join(root,'.pages');
await mkdir(output,{recursive:true});
await cp(path.join(root,'public'),output,{recursive:true,force:true});
await mkdir(path.join(output,'config'),{recursive:true});
await cp(path.join(root,'config/game.json'),path.join(output,'config/game.json'));
const alias={
  'node:fs':path.join(root,'browser/browser-fs.mjs'),
  'node:path':path.join(root,'browser/browser-path.mjs'),
  'node:crypto':path.join(root,'browser/browser-crypto.mjs'),
};
await build({entryPoints:[path.join(root,'browser/pages-entry.mjs')],outfile:path.join(output,'pages-runtime.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true,alias,logLevel:'warning'});

async function rewrite(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()){await rewrite(file);continue;}
    if(!/\.(?:js|css|html|webmanifest|json)$/.test(file)||file.endsWith('pages-runtime.js'))continue;
    let text=await readFile(file,'utf8');
    text=text.replaceAll('https://nongtrai.jackle.dev/',siteUrl).replaceAll('https://nongtrai.jackle.dev',siteUrl.replace(/\/$/,''));
    for(const prefix of ['/assets/','/icons/'])text=text.replaceAll(prefix,base+prefix.slice(1));
    for(const filename of ['push-sw.js','manifest.webmanifest','privacy.html','privacy-vi.html','delete-account.html'])text=text.replaceAll('/'+filename,base+filename);
    // Vite lazy dependency preloads prepend "/" to "assets/..." themselves.
    text=text.replace(/return"\/"\+([\w$]+)/g,(_,identifier)=>`return${JSON.stringify(base)}+${identifier}`);
    await writeFile(file,text);
  }
}
await rewrite(output);
const indexPath=path.join(output,'index.html');
let index=await readFile(indexPath,'utf8');
const moduleTag=/<script type="module" crossorigin src="([^"]+)"><\/script>/;
const match=index.match(moduleTag);if(!match)throw new Error('Reference main module was not found.');
const bootstrap=`<script type="module">\nimport {bootPagesRuntime} from ${JSON.stringify(base+'pages-runtime.js')};\ntry {\nwindow.__xntLocalReady=bootPagesRuntime();\nawait window.__xntLocalReady;\nawait import(${JSON.stringify(match[1])});\n} catch(error) {\nconsole.error(error);\ndocument.getElementById('root').innerHTML='<div style="max-width:420px;margin:20vh auto;padding:28px;background:#fff6e6;border:2px solid #33812a;border-radius:24px;text-align:center;font:18px system-ui;color:#503414"><h2>Xóm Nông Trại</h2><p>Không mở được nông trại. Hãy tải lại trang hoặc cho phép trang lưu dữ liệu trên thiết bị.</p><button id="local-reload" style="padding:12px 20px">Tải lại</button></div>';\ndocument.getElementById('local-reload').onclick=()=>location.reload();\n}\n</script>`;
index=index.replace(moduleTag,bootstrap);
await writeFile(indexPath,index);await writeFile(path.join(output,'404.html'),index);
const manifestPath=path.join(output,'manifest.webmanifest');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
Object.assign(manifest,{id:base,start_url:base,scope:base});
await writeFile(manifestPath,JSON.stringify(manifest,null,2));
await writeFile(path.join(output,'.nojekyll'),'');
console.log(`Pages build: ${output}\nBase: ${base}\nURL: ${siteUrl}`);
