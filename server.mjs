import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createBackend } from './src/backend.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const config = JSON.parse(await readFile(path.join(root, 'config/game.json'), 'utf8'));
const gameSpeed=Number(process.env.GAME_SPEED || 1);
if(!Number.isFinite(gameSpeed)||gameSpeed<=0)throw new Error('GAME_SPEED must be a positive number.');
const backend = createBackend({ dataDir: process.env.DATA_DIR || path.join(root, '.local'), config, gameSpeed });
const port = Number(process.env.PORT || 5173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535.');
const host = process.env.HOST || '127.0.0.1';
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.glb':'model/gltf-binary', '.mp3':'audio/mpeg' };
function json(res, status, body) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify({error:body})); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      let text = '';
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) { json(res,413,{code:'BODY_TOO_LARGE',message:'Request too large'}); return; } }
      let body = {};
      if (text) { try { body = JSON.parse(text); } catch { json(res,400,{code:'INVALID_JSON',message:'Invalid JSON'}); return; } }
      if (await backend.handle(req,res,pathname,body)) return;
      console.log(`Unavailable local API: ${req.method} ${pathname}`);
      json(res,501,{code:'LOCAL_UNAVAILABLE',message:'Tính năng này cần máy chủ trực tuyến của trò chơi gốc. Bản cục bộ hỗ trợ trồng trọt, chăn nuôi, sản xuất và xây dựng.'});
      return;
    }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filename = path.resolve(publicDir, relative);
    if (!filename.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    let details;
    try { details = await stat(filename); } catch { res.writeHead(404); res.end('Not found'); return; }
    if (!details.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'content-type': mime[path.extname(filename)] || 'application/octet-stream', 'content-length':details.size, 'cache-control':'no-cache' };
    res.writeHead(200,headers);
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res,500,{code:'LOCAL_ERROR',message:'Có lỗi trong máy chủ cục bộ.'}); else res.end();
  }
});

function frame(data, opcode=1) {
  const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const header = bytes.length < 126 ? Buffer.from([128|opcode,bytes.length]) : Buffer.from([128|opcode,126,bytes.length>>8,bytes.length&255]);
  return Buffer.concat([header,bytes]);
}
const sockets = new Set();
let publishedObjects = new Map(backend.getWorld().objects.map(object => [object.id, JSON.stringify(object)]));
function publishWorld() {
  const world = backend.getWorld();
  const next = new Map(world.objects.map(object => [object.id, JSON.stringify(object)]));
  const objects = world.objects.filter(object => next.get(object.id) !== publishedObjects.get(object.id));
  const removed = [...publishedObjects.keys()].filter(id => !next.has(id));
  if (objects.length || removed.length) {
    const message = frame({t:'world_delta',p:{ownerId:world.owner.id,objects,removed}});
    for(const socket of sockets)if(!socket.destroyed)socket.write(message);
  }
  publishedObjects = next;
}
backend.setOnMutation?.(event => {
  publishWorld();
  if (event.tutorialStep !== event.previousTutorialStep) {
    const message=frame({t:'tutorial_update',p:{step:event.tutorialStep,completedStepId:`local_${event.previousTutorialStep}`}});
    for(const socket of sockets)if(!socket.destroyed)socket.write(message);
  }
});
const worldTimer = setInterval(() => { if (sockets.size) publishWorld(); }, 1000);
worldTimer.unref();
server.on('close', () => clearInterval(worldTimer));
server.on('upgrade',(req,socket)=>{
  if (new URL(req.url,'http://localhost').pathname !== '/ws' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(frame({t:'hello',p:{serverTime:backend.getServerTime?.() || backend.now(),configVersion:config.version || '1.0.0',lastEventId:0}}));
  sockets.add(socket);
  socket.on('close',()=>sockets.delete(socket));
  let pending=Buffer.alloc(0);
  socket.on('data', chunk=>{
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=2){
      const opcode=pending[0]&15,masked=Boolean(pending[1]&128);let length=pending[1]&127,offset=2;
      if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}
      if(length===127||length>65536){socket.destroy();return;}
      const maskOffset=offset;if(masked)offset+=4;
      if(pending.length<offset+length)return;
      const payload=Buffer.from(pending.subarray(offset,offset+length));
      if(masked)for(let i=0;i<length;i++)payload[i]^=pending[maskOffset+i%4];
      pending=pending.subarray(offset+length);
      if(opcode===8){socket.end(frame('',8));return;}
      if(opcode===9){socket.write(frame(payload.toString(),10));continue;}
      if(opcode===1)try{if(JSON.parse(payload.toString()).t==='ping')socket.write(frame({t:'pong',p:{}}));}catch{}
    }
  });
  socket.on('error',()=>{});
});
server.listen(port,host,()=>console.log(`Xóm Nông Trại local: http://${host}:${port}\nProgress: ${process.env.DATA_DIR || path.join(root,'.local')}\nGame speed: ${process.env.GAME_SPEED || 1}x`));
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is in use. Set PORT to another port.`:error);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0));});
