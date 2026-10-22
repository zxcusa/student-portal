const fs=require('node:fs');
const path=require('node:path');
const {Script}=require('node:vm');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(['node_modules','.git','.runtime'].includes(e.name))return [];const p=path.join(dir,e.name);return e.isDirectory()?walk(p):p.endsWith('.js')?[p]:[];});}
let failed=false;for(const file of walk('.')){try{new Script(fs.readFileSync(file,'utf8'),{filename:file});}catch(error){failed=true;console.error(file,error.message);}}
if(failed)process.exitCode=1;else console.log('Barcha JavaScript fayllari sintaktik tekshiruvdan o‘tdi.');
