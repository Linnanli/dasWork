import { build } from '/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/esbuild/lib/main.js'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
const sourcePath='/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/artifacts/rasterizePresentationSvg.ts'
const output='/private/tmp/officecli-36403623699-fixed-viewport-control'
await mkdir(output,{recursive:true})
const deck='/private/tmp/officecli-36403623699-windows-diagnostics/_temp/runtime-dist/win32-x64/r07-visual/r07-ai-agent-security-market.pptx'
const officecli='/private/tmp/officecli-real-inputs-materialized/dependencies/native/officecli/officecli'
const {writeFile}=await import('node:fs/promises')
for(let index=1;index<=6;index++){
 const result=spawnSync(officecli,['view',deck,'svg','--start',String(index),'--end',String(index)],{encoding:'utf8',maxBuffer:8*1024*1024})
 if(result.status!==0)throw new Error(result.stderr)
 await writeFile(output+'/slide-'+String(index).padStart(2,'0')+'.svg',result.stdout.trim())
}
const file=output+'/control.cjs'
await build({stdin:{contents:`
import {app} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {rasterizePresentationSvg} from '${sourcePath}';
const reports=[];
app.on('window-all-closed',()=>{});
app.on('web-contents-created',(_event,contents)=>{
 const original=contents.capturePage.bind(contents);
 contents.capturePage=async(...args)=>{
  const viewport=JSON.parse(await contents.executeJavaScriptInIsolatedWorld(1002,[{code:'JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})'}]));
  const image=await original(...args);reports.push({viewport,captureSize:image.getSize()});return image;
 };
});
app.whenReady().then(async()=>{try{
 for(let index=1;index<=6;index++){
  const name='slide-'+String(index).padStart(2,'0');
  const png=await rasterizePresentationSvg(await readFile('${output}/'+name+'.svg','utf8'),45000,'/private/tmp/officecli-real-inputs-materialized/fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf');
  await writeFile('${output}/'+name+'.png',png);
  Object.assign(reports.at(-1),{file:name+'.png',sha256:createHash('sha256').update(png).digest('hex')});
  const report=reports.at(-1);
  if(report.viewport.width!==1920||report.viewport.height!==1080||report.viewport.scrollWidth!==1920||report.viewport.scrollHeight!==1080)throw new Error('Slide viewport is cropped: '+JSON.stringify(report));
  if(report.captureSize.width/report.captureSize.height!==16/9)throw new Error('Capture aspect is wrong');
  console.log(name,JSON.stringify(report));
 }
 await writeFile('${output}/viewport-report.json',JSON.stringify(reports,null,2)+'\\n');app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`,resolveDir:'/Users/nallylin/Documents/code/dasCowork/desktop-app',loader:'ts'},outfile:file,bundle:true,platform:'node',format:'cjs',external:['electron'],plugins:[{name:'initial-small-window',setup(plugin){plugin.onLoad({filter:/rasterizePresentationSvg\.ts$/},async()=>({contents:(await readFile(sourcePath,'utf8')).replace('window.webContents.setWindowOpenHandler','window.setContentSize(1008, 681);\n    window.webContents.setWindowOpenHandler'),loader:'ts'}))}}]})
const status=await new Promise((resolve,reject)=>{const child=spawn('/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',[file],{stdio:'inherit'});child.once('error',reject);child.once('exit',resolve)})
if(status!==0)throw new Error('Fixed viewport control failed '+status)
