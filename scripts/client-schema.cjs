const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function defaultClientPath() {
  const candidates = [path.resolve(__dirname, '../reference/client.js'), path.resolve(__dirname, 'client-pretty.js')];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('Pass a path to the preserved public reference/client.js bundle.');
  return found;
}

function loadClientSchemas(clientPath = defaultClientPath()) {
  const source = fs.readFileSync(clientPath, 'utf8');
  const start = /var M\s*,\s*R\s*,\s*L\s*;/.exec(source)?.index;
  const end = /const Or\s*=/.exec(source)?.index;
  if (start === undefined || end === undefined || start >= end) throw new Error('Unsupported reference bundle: schema boundaries were not found.');
  // Execute the self-contained Zod definitions and table schemas only. The React,
  // browser bootstrap, network code, authentication actions and game are excluded.
  const context = { i: (object,key,value) => object[key] = value };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end) + ';globalThis.schemas={Ui,Ti,Ai,Dn,Fn,Un,zn,Gn,Hn,Wn,Yn,Zn,ui,pi,ci,sa,Ta,ya,Sa,Ea,wr,ja,Ma,ca,Ra};', context, {timeout:10000});
  const mapStart = /const _f\s*=\s*\[/.exec(source)?.index;
  const mapEnd = /function Ff\(/.exec(source)?.index;
  if (mapStart === undefined || mapEnd === undefined) throw new Error('Reference asset ID maps were not found.');
  vm.runInContext(source.slice(mapStart,mapEnd) + ';globalThis.maps={vf,kf,If,Af,Tf,Mf};', context, {timeout:10000});
  return { schemas:context.schemas, maps:context.maps, clientPath };
}
module.exports = {loadClientSchemas,defaultClientPath};
