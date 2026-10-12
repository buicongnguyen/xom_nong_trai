const fs = require('node:fs');
const path = require('node:path');
const { loadClientSchemas } = require('./client-schema.cjs');
const configPath = process.argv[2] || path.resolve(__dirname,'../config/game.json');
const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
const { schemas } = loadClientSchemas(process.argv[3]);
const parsed = schemas.Ui.safeParse(config.bundle);
if (!parsed.success) {
  console.error(JSON.stringify(parsed.error.issues,null,2)); process.exitCode=1;
} else {
  if (!config.version || !config.checksum) throw new Error('Expected API response {version,checksum,bundle}.');
  console.log(`Configuration matches preserved client schema (${Object.keys(parsed.data).length} tables).`);
}
