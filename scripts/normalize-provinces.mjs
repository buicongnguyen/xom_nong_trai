import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file = new URL('../config/game.json', import.meta.url);
const config = JSON.parse(await readFile(file, 'utf8'));
for (const province of config.bundle.provinces.provinces) province.id = province.name.normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
config.version = '1.0.1';
config.bundle.gameConfig.configVersion = config.version;
config.checksum = createHash('sha256').update(JSON.stringify(config.bundle)).digest('hex');
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
console.log('Normalized 34 province IDs to the IDs used by the map.');
