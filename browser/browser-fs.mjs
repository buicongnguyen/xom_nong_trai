// Synchronous subset used by the game backend. Every farm belongs to this
// browser and Pages project; temporary writes keep the backend's save pattern.
const namespace = () => `xnt:pages:${new URL('.', import.meta.url).pathname}:`;
const keyFor = name => namespace() + String(name);

function storage() {
  try { return globalThis.localStorage; }
  catch {
    throw Object.assign(new Error('Browser storage is unavailable. Allow site storage to save your farm.'), {
      code: 'STORAGE_UNAVAILABLE', status: 503,
    });
  }
}

export function mkdirSync() {}
export function existsSync(name) { return storage().getItem(keyFor(name)) !== null; }
export function readFileSync(name) {
  const value = storage().getItem(keyFor(name));
  if (value === null) throw Object.assign(new Error(`Missing local save: ${name}`), { code: 'ENOENT' });
  return value;
}
export function writeFileSync(name, contents) { storage().setItem(keyFor(name), String(contents)); }
export function renameSync(from, to) {
  const content = readFileSync(from);
  storage().setItem(keyFor(to), content);
  storage().removeItem(keyFor(from));
}
export default { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync };
