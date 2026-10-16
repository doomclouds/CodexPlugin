import { compileCodeProject } from './code-preview.ts';
import type { CodeProject } from './code-project.ts';
import { inspectCodeHtml, type BrowserInspection } from './code-browser.ts';
import { zipFiles } from './export.ts';

export async function renderCodeProject(project:CodeProject,options:{viewportId?:string;pdf?:boolean;fullPage?:boolean}={}):Promise<BrowserInspection>{
  const viewport=project.viewports.find(view=>view.id===(options.viewportId??project.viewports[0]?.id));
  if(!viewport)throw new Error('Viewport not found.');
  const compiled=await compileCodeProject(project,{instrument:false});
  const failures=compiled.diagnostics.filter(item=>item.level==='error');
  if(failures.length)throw new Error(`Prototype compilation failed: ${failures.slice(0,3).map(item=>`${item.file??'project'}${item.line?`:${item.line}`:''}: ${item.message}`).join('; ')}`);
  return inspectCodeHtml(compiled.html,{width:viewport.width,height:viewport.height,pdf:options.pdf,fullPage:options.fullPage});
}

export async function exportCodeProject(project:CodeProject,format:'html'|'zip'|'png'|'pdf',viewportId?:string):Promise<{filename:string;mimeType:string;dataBase64:string}>{
  let bytes:Buffer;
  if(format==='html'||format==='zip'){
    const compiled=await compileCodeProject(project,{instrument:false});
    if(compiled.diagnostics.some(item=>item.level==='error'))throw new Error('Fix the prototype compilation errors before export.');
    if(format==='html')bytes=Buffer.from(compiled.html);
    else{
      // Keep raw source and the runnable single-file prototype separately.
      const files=project.files.map(file=>({name:`source/${file.path}`,data:Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8')}));
      files.push({name:'prototype.html',data:Buffer.from(compiled.html)},{name:'design-project.json',data:Buffer.from(JSON.stringify(project,null,2))});
      bytes=zipFiles(files);
    }
  }else{const rendered=await renderCodeProject(project,{viewportId,pdf:format==='pdf'});bytes=format==='pdf'?rendered.pdf!:rendered.png;}
  if(bytes.length>32*1024*1024)throw new Error('Export exceeds the 32 MiB transfer budget.');
  return{filename:`${project.name.replace(/[^\p{L}\p{N}._-]+/gu,'-').slice(0,80)||'design'}.${format}`,mimeType:{html:'text/html',zip:'application/zip',png:'image/png',pdf:'application/pdf'}[format],dataBase64:bytes.toString('base64')};
}
