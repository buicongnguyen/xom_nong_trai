import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) throw new Error('Pass the destination repository');
const origin = 'https://nongtrai.jackle.dev';
const output = path.join(target, 'public');
await mkdir(output, { recursive: true });
const queue = ['/'];
const seen = new Set(queue);
const records = [];
const failed = [];
const extensions = /\.(?:js|css|json|webmanifest|glb|gltf|png|jpg|jpeg|webp|svg|woff2?|mp3|ogg|wav)$/i;
function enqueue(raw, from) {
  if (!raw || raw.includes('..') || raw.startsWith('data:') || raw.includes('${')) return;
  let url;
  try { url = new URL(raw, new URL(from, origin)); } catch { return; }
  if (url.origin !== origin || !extensions.test(url.pathname) || url.pathname.startsWith('/cdn-cgi/')) return;
  if (!seen.has(url.pathname)) { seen.add(url.pathname); queue.push(url.pathname); }
}
function discover(text, pathname) {
  for (const match of text.matchAll(/["'`](\/?(?:assets|fonts|icons|audio|images)\/[^"'`\s<>]+)["'`]/g)) enqueue(match[1].startsWith('/') ? match[1] : '/' + match[1], pathname);
  for (const match of text.matchAll(/["'](\.\/[^"'\s]+\.(?:js|css|json))["']/g)) enqueue(match[1], pathname);
  if (pathname === '/') for (const match of text.matchAll(/(?:src|href)=["']([^"'\s<>]+)["']/g)) enqueue(match[1], pathname);
  if (pathname.endsWith('.css')) for (const match of text.matchAll(/url\(["']?([^"'\s)]+)["']?\)/g)) enqueue(match[1], pathname);
}
function discoverModel(bytes, pathname) {
  if (!pathname.endsWith('.glb') || bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) return;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length=bytes.readUInt32LE(offset), type=bytes.readUInt32LE(offset+4);
    if (type===0x4e4f534a) {
      const data=JSON.parse(bytes.subarray(offset+8,offset+8+length).toString('utf8'));
      for(const asset of [...(data.images || []),...(data.buffers || [])])if(asset.uri)enqueue(asset.uri,pathname);
    }
    offset += 8 + length;
  }
}
async function download(pathname) {
  const localPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const destination = path.resolve(output, localPath);
  if (!destination.startsWith(path.resolve(output) + path.sep)) throw new Error('Asset escaped destination');
  let cached;
  try { cached = await readFile(destination); } catch {}
  if (cached?.length && (!pathname.endsWith('.glb') || (cached.length >= 20 && cached.readUInt32LE(0) === 0x46546c67 && cached.readUInt32LE(8) === cached.length))) {
    if (pathname === '/' || /\.(js|css|json|webmanifest)$/.test(pathname)) discover(cached.toString('utf8'), pathname);
    discoverModel(cached, pathname);
    records.push({ path: localPath, bytes: cached.length, sha256: createHash('sha256').update(cached).digest('hex'), source: origin + pathname });
    return;
  }
  let response;
  let bytes;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      if (process.platform === 'win32') {
        await new Promise((resolve,reject) => {
          const child=spawn('pwsh',['-NoProfile','-File',fileURLToPath(new URL('./fetch-asset.ps1',import.meta.url)),origin+pathname,destination],{windowsHide:true,stdio:['ignore','ignore','pipe']});
          let error='';child.stderr.on('data',chunk=>error+=chunk);
          child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error.slice(0,200)||`Download exit ${code}`)));
        });
        bytes = await readFile(destination);
      } else {
        response = await fetch(origin + pathname, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      break;
    } catch (error) {
      if (attempt === 3) { failed.push({ path: pathname, error: error.message }); return; }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  const contentType = response?.headers.get('content-type') ?? (bytes.toString('utf8',0,80).includes('<!doctype html>')?'text/html':'');
  if (pathname !== '/' && /text\/html/.test(contentType)) { failed.push({ path: pathname, error: 'Unexpected HTML' }); return; }
  if (pathname === '/' || /\.(js|css|json|webmanifest)$/.test(pathname)) {
    let text = bytes.toString('utf8');
    discover(text, pathname);
    if (pathname === '/') {
      text = text.replace(/<script[^>]*src="https:\/\/static\.cloudflareinsights\.com[\s\S]*?<\/script>/g, '')
        .replace(/<script>\(function\(\)\{function c\(\)[\s\S]*?<\/script>/g, '');
      bytes = Buffer.from(text);
    }
  }
  discoverModel(bytes, pathname);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  records.push({ path: localPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source: origin + pathname });
  if (records.length % 20 === 0) console.log(`Downloaded ${records.length} files; ${queue.length} remaining`);
}
while (queue.length) {
  const batch = queue.splice(0, 6);
  await Promise.all(batch.map(download));
}
await mkdir(path.join(target, 'reference'), { recursive: true });
await writeFile(path.join(target, 'reference', 'assets-manifest.json'), JSON.stringify({ origin, retrievedAt: new Date().toISOString(), files: records.sort((a,b) => a.path.localeCompare(b.path)), failed }, null, 2));
console.log(JSON.stringify({ downloaded: records.length, bytes: records.reduce((n,r) => n+r.bytes, 0), failed }));
