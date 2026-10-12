import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The upstream React source is unavailable. Keep small, guarded corrections to
// its preserved compiled UI reproducible, rather than silently editing a bundle.
const file = fileURLToPath(new URL('../public/assets/FactoryPopup-D2otc8Mx.js', import.meta.url));
let source = await readFile(file, 'utf8');
function replaceOnce(before, after) {
  if (source.includes(after)) return;
  if (source.split(before).length !== 2) throw new Error('Client UI patch anchor changed: ' + before);
  source = source.replace(before, after);
}
replaceOnce('return 0===t?a.jsx(me,{objId:X.id,job:e,name:i', 'return o<=Se?a.jsx(me,{objId:X.id,job:e,jobIndex:t,name:i');
replaceOnce('function me({objId:e,job:t,name:o', 'function me({objId:e,job:t,jobIndex:j=0,name:o');
const start = source.indexOf('function me(');
const end = source.indexOf('function xe(', start);
if (start < 0 || end < start) throw new Error('Factory running-row component was not found.');
let row = source.slice(start, end);
if (row.includes('jobIndex:0')) {
  if (row.split('jobIndex:0').length !== 4) throw new Error('Factory speed-up targets changed.');
  row = row.replaceAll('jobIndex:0', 'jobIndex:j');
}
row = row.replace('[e,t.endAt,p])', '[e,t.endAt,p,j])');
row = row.replace('target:{objId:e},kind:"factory"', 'target:{objId:e,jobIndex:j},kind:"factory"');
source = source.slice(0, start) + row + source.slice(end);
await writeFile(file, source);
console.log('Factory UI: each running worker row uses its own queue index.');
const mainFile = fileURLToPath(new URL('../public/assets/index-Gy4nOY45.js', import.meta.url));
source = await readFile(mainFile, 'utf8');
replaceOnce('openModal:(t=!1)=>e({open:!0,autoTriggered:t})',
  'openModal:(t=!1)=>globalThis.__xntLocalEdition?(t?void 0:globalThis.dispatchEvent(new Event("xnt:online-unavailable"))):e({open:!0,autoTriggered:t})');
await writeFile(mainFile, source);
console.log('Local account UI: suppress automatic online signup; explain manual requests.');
