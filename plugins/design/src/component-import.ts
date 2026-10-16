import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJavaScript } from '@babel/parser';
import type * as ESBuild from 'esbuild-wasm';
import { CODE_PROJECT_LIMITS, validateCodePath } from './code-project.ts';
import type { CodeFile, CodeProject } from './code-project.ts';
import type { PreviewDiagnostic } from './code-preview.ts';

export interface ComponentSystemInput {
  directory: string;
  entries: Array<{ name: string; path: string; exportName?: string; usage?: string }>;
  cssFiles?: string[];
  typeFiles?: string[];
  notes?: string;
}
export interface ComponentSystemBundle {
  files: CodeFile[];
  components: CodeProject['designSystem']['components'];
  notes: string;
  provenance: { sourceHashes: Record<string, string>; packages?: Array<{ name: string; version?: string; path: string }> };
  diagnostics: PreviewDiagnostic[];
}
export const COMPONENT_IMPORT_LIMITS = { files: 128, inputBytes: 32 * 1024 * 1024, inputFileBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, entries: 64 } as const;
const reactModules = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
const loaders: Record<string, ESBuild.Loader> = { '.js':'js', '.mjs':'js', '.cjs':'js', '.jsx':'jsx', '.ts':'ts', '.tsx':'tsx', '.css':'css', '.json':'json' };
const media: Record<string, string> = { '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf' };
const reserved = new Set(['await','break','case','catch','class','const','continue','debugger','default','delete','do','else','enum','export','extends','false','finally','for','function','if','implements','import','in','instanceof','interface','let','new','null','package','private','protected','public','return','static','super','switch','this','throw','true','try','typeof','var','void','while','with','yield']);
const identifier = (name: string): boolean => /^[$A-Z_a-z][$\w]*$/.test(name) && !reserved.has(name);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);
let engine: typeof ESBuild | undefined;
function compiler(): typeof ESBuild {
  if (engine) return engine;
  try { engine = require(fileURLToPath(new URL('../runtime/vendor/esbuild-wasm/lib/main.js', import.meta.url))) as typeof ESBuild; }
  catch { if (!fileURLToPath(import.meta.url).endsWith('/src/component-import.ts')) throw new Error('The packaged component compiler is missing. Rebuild the Design plugin.'); engine = require('esbuild-wasm') as typeof ESBuild; }
  return engine;
}
function safeRelative(path: string): string {
  if (!path || path.length > 512 || isAbsolute(path) || /[\\\x00-\x1f:#?%]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || ['.git','.codex','.agents'].includes(part.toLowerCase()))) throw new Error('Choose a contained project-relative component, CSS or API path.');
  return path;
}
function walk(node: unknown, callback: (node: Record<string, any>) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child,callback); return; }
  const value = node as Record<string,any>;
  if (typeof value.type === 'string') callback(value);
  for (const [key,child] of Object.entries(value)) if (!['loc','start','end','comments','tokens','extra'].includes(key)) walk(child,callback);
}

export async function bundleComponentSystem(input: ComponentSystemInput): Promise<ComponentSystemBundle> {
  if (!isAbsolute(input.directory)) throw new Error('Choose an absolute component-system source directory.');
  const rootInfo = await lstat(input.directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The component source root must be a real directory.');
  const root = await realpath(input.directory);
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > COMPONENT_IMPORT_LIMITS.entries) throw new Error('Choose 1 to 64 real component entries.');
  const names = new Set<string>();
  for (const entry of input.entries) {
    if (!identifier(entry.name) || names.has(entry.name)) throw new Error('Component names must be unique, non-reserved JavaScript identifiers.'); names.add(entry.name);
    safeRelative(entry.path);
    if (entry.exportName !== undefined && entry.exportName !== 'default' && !identifier(entry.exportName)) throw new Error('Component exportName must be default or a named JavaScript export.');
    if (entry.usage !== undefined && (typeof entry.usage !== 'string' || entry.usage.length > 10_000)) throw new Error('A component usage note is limited to 10000 characters.');
  }
  if ((input.cssFiles?.length ?? 0) > 32 || (input.typeFiles?.length ?? 0) > 32 || (input.notes?.length ?? 0) > 100_000) throw new Error('Component CSS, API or notes budget exceeded.');
  for (const path of [...input.cssFiles ?? [], ...input.typeFiles ?? []]) safeRelative(path);
  const diagnostics: PreviewDiagnostic[] = []; const hashes: Record<string,string> = Object.create(null) as Record<string,string>;
  const cache = new Map<string,Buffer>(); const packages = new Map<string,{name:string;version?:string;path:string}>();
  const pending = new Map<string,Promise<{path:string;bytes:Buffer}>>();
  let inputBytes = 0;
  const portable = (path: string): string => relative(root,path).split(sep).join('/');
  const sanitize = (value: string): string => value.replaceAll(root,'<source-root>').replaceAll(input.directory,'<source-root>');
  const contained = async (path: string): Promise<string> => {
    const canonical = await realpath(path); const rel = relative(root,canonical);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..'+sep)) throw new Error('A component dependency resolves outside the selected source root. Select a root that contains the complete workspace.');
    if (rel.split(sep).some((part) => ['.git','.codex','.agents'].includes(part.toLowerCase()))) throw new Error('Component imports cannot read reserved configuration directories.');
    return canonical;
  };
  const read = async (path: string): Promise<{ path: string; bytes: Buffer }> => {
    const canonical = await contained(path);
    const cached = cache.get(canonical); if (cached) return {path:canonical,bytes:cached};
    const existing=pending.get(canonical);if(existing)return existing;
    if (cache.size + pending.size >= COMPONENT_IMPORT_LIMITS.files) throw new Error('Component import exceeds 128 source/resource files. Narrow the selected surface.');
    const acquisition=(async()=>{
      const file = await open(canonical,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await file.stat(); if (!info.isFile() || info.size > COMPONENT_IMPORT_LIMITS.inputFileBytes) throw new Error('A component resource is not a regular file or exceeds 8 MiB.');
        const bytes = await file.readFile(); if (bytes.length > COMPONENT_IMPORT_LIMITS.inputFileBytes || inputBytes + bytes.length > COMPONENT_IMPORT_LIMITS.inputBytes) throw new Error('Component source/resource input budget exceeded.');
        inputBytes += bytes.length; cache.set(canonical,bytes); hashes[portable(canonical)] = digest(bytes); return {path:canonical,bytes};
      } finally { await file.close(); }
    })();pending.set(canonical,acquisition);try{return await acquisition;}finally{pending.delete(canonical);}
  };
  const recordPackage = async (path: string): Promise<void> => {
    const rel = portable(path); const segments = rel.split('/'); const last = segments.lastIndexOf('node_modules');
    if (last < 0) return;
    const count = segments[last+1]?.startsWith('@') ? 3 : 2; const packagePath = segments.slice(0,last+count).join('/')+'/package.json';
    if (packages.has(packagePath)) return;
    try { const raw = await read(join(root,packagePath)); const value:unknown = JSON.parse(raw.bytes.toString('utf8')); if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string' && /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(value.name)) { const version='version' in value&&typeof value.version==='string'&&/^[\w.+-]{1,100}$/.test(value.version)?value.version:undefined;packages.set(packagePath,{name:value.name,...(version?{version}:{}),path:packagePath}); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  const data = async (path: string, suffix = ''): Promise<string> => {
    const raw = await read(path); const mime = media[extname(raw.path).toLowerCase()];
    if (!mime) throw new Error('Only contained images and fonts can be embedded as component resources.');
    return `data:${mime};base64,${raw.bytes.toString('base64')}`+suffix;
  };
  for (const entry of input.entries) await contained(resolve(root,entry.path));
  for (const path of input.cssFiles ?? []) if (extname(path).toLowerCase() !== '.css') throw new Error('cssFiles must select real CSS files.');
  for (const path of input.typeFiles ?? []) if (!/\.d\.[cm]?ts$/i.test(path)) throw new Error('typeFiles must select existing declaration files such as .d.ts.');
  const imports = [
    ...input.entries.map((entry) => `export {${entry.exportName ?? 'default'} as ${entry.name}} from ${JSON.stringify('./'+entry.path)};`),
    ...(input.cssFiles ?? []).map((path) => `import ${JSON.stringify('./'+path)};`),
  ].join('\n');
  const plugin: ESBuild.Plugin = {name:'design-real-component-import',setup(build){
    build.onResolve({filter:/.*/},async(args)=>{
      if (args.pluginData?.designResolutionBypass) return undefined;
      if (reactModules.has(args.path)) return {path:args.path,external:true};
      if (args.kind === 'url-token' && (args.path.startsWith('data:') || args.path.startsWith('#'))) return {path:args.path,external:true};
      if (/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(args.path)) return {errors:[{text:'External URLs and native-module dependencies are not supported by the contained component bundle.'}]};
      try {
        const resolution = await build.resolve(args.path,{resolveDir:args.resolveDir || root,kind:args.kind,pluginData:{designResolutionBypass:true}});
        if (resolution.errors.length || !resolution.path || resolution.external) return {errors:[{text:`Dependency is missing or unsupported: ${sanitize(args.path)}. Install nothing automatically; select a root containing its existing source or node_modules.`}]};
        const canonical = await contained(resolution.path);
        if (args.kind === 'url-token') return {path:await data(canonical,resolution.suffix),external:true};
        return {path:portable(canonical),namespace:'component-source',sideEffects:extname(canonical).toLowerCase()==='.css'?true:resolution.sideEffects,pluginData:{canonical}};
      } catch (error) { return {errors:[{text:sanitize(error instanceof Error?error.message:'Component dependency resolution failed.')}]}; }
    });
    build.onLoad({filter:/.*/,namespace:'component-source'},async(args)=>{
      try {
        const raw = await read(args.pluginData?.canonical ?? join(root,args.path)); await recordPackage(raw.path);
        const extension = extname(raw.path).toLowerCase();
        if (media[extension]) return {contents:`export default ${JSON.stringify(await data(raw.path))}`,loader:'js'};
        const loader = loaders[extension]; if (!loader) return {errors:[{text:'Unsupported component source extension: '+extension}]};
        const content = new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes);
        if (['js','jsx','ts','tsx'].includes(loader)) {
          const ast = parseJavaScript(content,{sourceType:'unambiguous',plugins:['jsx','typescript']});
          walk(ast,(node)=>{if (node.type==='ImportExpression'&&node.source?.type!=='StringLiteral'||node.type==='CallExpression'&&(node.callee?.type==='Import'||node.callee?.type==='Identifier'&&node.callee.name==='require')&&node.arguments?.[0]?.type!=='StringLiteral') throw new Error('Dynamic component dependency expressions cannot be made self-contained. Select an explicit static dependency surface.');});
        }
        return {contents:content,loader,resolveDir:dirname(raw.path)};
      } catch (error) { return {errors:[{text:sanitize(error instanceof Error?error.message:'Component source acquisition failed.')}]}; }
    });
  }};
  let built: ESBuild.BuildResult;
  try {
    built = await compiler().build({stdin:{contents:imports,resolveDir:root,sourcefile:'design-system-entry.js',loader:'js'},bundle:true,write:false,outdir:join(root,'.design-component-output'),entryNames:'design-system',format:'esm',platform:'browser',target:['es2022'],jsx:'automatic',jsxImportSource:'react',plugins:[plugin],logLevel:'silent',minify:true,legalComments:'none',metafile:true,define:{'process.env.NODE_ENV':'"production"'}});
  } catch (error) {
    const issues = (error as {errors?:Array<{text:string}>}).errors;
    throw new Error('Real component bundle failed: '+sanitize(issues?.slice(0,8).map((item)=>item.text).join('; ') || (error instanceof Error?error.message:'unknown compiler failure')));
  }
  for (const warning of built.warnings) diagnostics.push({level:'warning',message:sanitize(warning.text)});
  const exported=new Set(Object.entries(built.metafile?.outputs??{}).filter(([path])=>path.endsWith('.js')).flatMap(([,output])=>output.exports));
  for(const entry of input.entries)if(!exported.has(entry.name))throw new Error(`Requested component export does not exist: ${entry.name}`);
  const files: CodeFile[] = [];
  for (const output of built.outputFiles ?? []) {
    const extension = extname(output.path); if (!['.js','.css'].includes(extension)) throw new Error('The component compiler emitted an unexpected resource type.');
    files.push({path:extension==='.js'?'vendor/design-system.js':'vendor/design-system.css',content:output.text,encoding:'utf8'});
  }
  if (!files.some((file)=>file.path==='vendor/design-system.js')) throw new Error('No executable component module was emitted.');
  const apiPaths: string[] = [];
  for (const [index,path] of (input.typeFiles ?? []).entries()) {
    const raw = await read(join(root,path)); const content = new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes); const output=`docs/design-system-api/${String(index+1).padStart(3,'0')}-${basename(path)}`;
    files.push({path:output,content,encoding:'utf8'});apiPaths.push(output);
  }
  const components = input.entries.map((entry)=>({name:entry.name,path:'vendor/design-system.js',exportName:entry.name,usage:entry.usage??`import { ${entry.name} } from './vendor/design-system.js';` }));
  const css = files.some((file)=>file.path==='vendor/design-system.css');
  const notes = [input.notes??'', '已静态打包用户选择的真实组件与传递资源；未执行项目代码、安装依赖或运行包脚本。React 与 React DOM 由 Design 内置运行时提供。', '导入不表示所有页面已使用这些组件。请按指南将真实组件、CSS 入口及所需 Provider 接入项目，再编译、运行并检查。'].filter(Boolean).join('\n\n');
  const guide = ['# 真实组件设计系统', '', notes, '', '## 项目中的实际入口', '', '以下路径从代码项目根目录解析；组件位于同一个实际 ESM 模块中。', '', '```tsx', `import { ${components.map((component)=>component.name).join(', ')} } from './vendor/design-system.js';`, '```', '', ...(css?['```html','<link rel="stylesheet" href="./vendor/design-system.css">','```','','也可从项目源码使用相对 import 加载同一份 CSS。','']:['本次组件没有发出 CSS 文件，不需要引用不存在的样式入口。','']), '## 组件与用户提供的用法', '', ...components.flatMap((component)=>[`### ${component.name}`, '', component.usage, '']), '## API 类型资料', '', ...(apiPaths.length?apiPaths.map((path)=>`- ${path}`):['用户未选择类型声明文件；本次未推测或生成组件 props/API。']), '', '这些资料来自用户明确选择的源文件；只有编译、浏览器运行和视觉审阅通过后，才可声称该项目已正确接入。'].join('\n');
  files.push({path:'docs/design-system-guide.md',content:guide,encoding:'utf8'});
  let outputBytes = 0;
  for (const file of files) {
    validateCodePath(file.path); const size=Buffer.byteLength(file.content);outputBytes+=size;
    if (size > CODE_PROJECT_LIMITS.textBytes) throw new Error(`Generated source exceeds the code project's 1 MiB per-file budget: ${file.path}. Narrow the selected components or resources.`);
    if (file.content.includes(root)||file.content.includes(input.directory)) throw new Error('A selected source or API document embeds an absolute source-root path. Supply portable source before importing.');
  }
  if (outputBytes > COMPONENT_IMPORT_LIMITS.outputBytes) throw new Error('Component import exceeds its 16 MiB output budget.');
  return {files,components,notes,provenance:{sourceHashes:Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b))),...(packages.size?{packages:[...packages.values()]}:{})},diagnostics};
}
