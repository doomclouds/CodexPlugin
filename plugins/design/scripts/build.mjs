import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'runtime'),{recursive:true});
const server=await build({absWorkingDir:root,entryPoints:['src/index.ts'],outfile:'runtime/index.js',bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,banner:{js:'import { createRequire } from "node:module"; const require=createRequire(import.meta.url);'}});
const ui=await build({absWorkingDir:root,entryPoints:['ui/app.ts'],bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,write:false,outfile:'app.js',metafile:true});
const script=ui.outputFiles.find(file=>file.path.endsWith('.js'))?.text??'';
const css=ui.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
const html=await readFile(path.join(root,'ui/index.html'),'utf8');
const panel=html.replace('{{SCRIPT}}',()=>script.replaceAll('</script','<\\/script')).replace('{{STYLE}}',()=>css);
for(const match of panel.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(match[1],{filename:'design-panel.js'});
await writeFile(path.join(root,'runtime/panel.html'),panel);
const dirs=new Set();
for(const input of [...Object.keys(server.metafile.inputs),...Object.keys(ui.metafile.inputs)]){
 const normalized=input.replaceAll('\\','/'),index=normalized.lastIndexOf('node_modules/');if(index<0)continue;
 const prefix=normalized.slice(0,index+'node_modules/'.length),parts=normalized.slice(prefix.length).split('/');
 dirs.add(path.resolve(root,prefix,parts.slice(0,parts[0].startsWith('@')?2:1).join('/')));
}
const notices=[];
for(const directory of [...dirs].sort()){
 const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
 let found=false;
 for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENSE-MIT'])try{const license=await readFile(path.join(directory,name),'utf8');notices.push(`${pkg.name}@${pkg.version}\n${license.trim()}`);found=true;break;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!found)notices.push(`${pkg.name}@${pkg.version}\nLicense: ${pkg.license??'See upstream package metadata'}`);
}
await writeFile(path.join(root,'runtime/third-party-licenses.txt'),notices.join('\n\n---\n\n')+'\n');
console.log('Built Design runtime and self-contained editor.');
