const fs = require('node:fs');
const { loadClientSchemas } = require('./client-schema.cjs');
const type = process.argv[2];
const filename = process.argv[3];
if (!type || !filename) throw new Error('Usage: node scripts/validate-response.cjs world|object|wallet|animal|factory|storage|quest response.json [reference/client.js]');
const {schemas}=loadClientSchemas(process.argv[4]);
const names={world:'wr',object:'Ta',wallet:'sa',animal:'ya',factory:'Sa',storage:'Ea',quest:'ja'};
const schema=schemas[names[type]];
if (!schema) throw new Error('Unknown response type '+type);
let value=JSON.parse(fs.readFileSync(filename,'utf8'));
if(type==='storage'&&value.storage)value=value.storage;
const result=schema.safeParse(value);
if(result.success)console.log(`Response matches preserved ${type} schema.`);
else {console.error(JSON.stringify(result.error.issues,null,2));process.exitCode=1;}
