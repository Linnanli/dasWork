import { build } from '/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/esbuild/lib/main.js'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const sourcePath = '/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/artifacts/rasterizePresentationSvg.ts'
const output = '/private/tmp/officecli-36412021750-chart-font-control'
const deck = '/private/tmp/officecli-calibration-36412021750/linux-x64/r07-visual/r07-ai-agent-security-market.pptx'
const officecli = '/private/tmp/officecli-real-inputs-materialized/dependencies/native/officecli/officecli'
const font = '/private/tmp/officecli-real-inputs-materialized/fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf'
await mkdir(output, { recursive: true })
for (let index = 1; index <= 6; index++) {
  const result = spawnSync(officecli, ['view', deck, 'svg', '--start', String(index), '--end', String(index)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr)
  await writeFile(`${output}/slide-${String(index).padStart(2, '0')}.svg`, result.stdout.trim())
}
const bundle = output + '/control.cjs'
await build({
  stdin: { contents: `
import {app} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {rasterizePresentationSvg} from '${sourcePath}';
const reports=[];
app.on('window-all-closed',()=>{});
app.on('web-contents-created',(_event,contents)=>{
  const capture=contents.capturePage.bind(contents);
  contents.capturePage=async(...args)=>{
    const state=JSON.parse(await contents.executeJavaScriptInIsolatedWorld(1002,[{code:
      'JSON.stringify({viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight},svgText:Array.from(document.querySelectorAll("text,tspan")).map(element=>({text:element.textContent,fontFamily:getComputedStyle(element).fontFamily,inlineFamily:element.style.fontFamily}))})'
    }]));
    const image=await capture(...args);
    reports.push({...state,captureSize:image.getSize()});
    return image;
  };
});
app.whenReady().then(async()=>{try{
  for(let index=1;index<=6;index++){
    const name='slide-'+String(index).padStart(2,'0');
    const png=await rasterizePresentationSvg(await readFile('${output}/'+name+'.svg','utf8'),45000,'${font}');
    await writeFile('${output}/'+name+'.png',png);
    const report=reports.at(-1);
    Object.assign(report,{file:name+'.png',sha256:createHash('sha256').update(png).digest('hex')});
    if(report.viewport.width!==1920||report.viewport.height!==1080||report.viewport.scrollWidth!==1920||report.viewport.scrollHeight!==1080)throw new Error('Cropped slide viewport');
    if(report.svgText.some(text=>!text.inlineFamily.includes('Noto Sans CJK SC')))throw new Error('SVG text lacks Runtime font fallback');
    if(index===5){for(const text of ['市场指标','市场规模（亿元）','企业试点渗透率（%）']){
      if(!report.svgText.some(entry=>entry.text===text&&entry.inlineFamily.includes('Noto Sans CJK SC')))throw new Error('Chart text missing Runtime fallback: '+text);
    }}
    console.log(name,JSON.stringify({size:report.captureSize,svgTextCount:report.svgText.length,sha256:report.sha256}));
  }
  await writeFile('${output}/font-layout-report.json',JSON.stringify(reports,null,2)+'\\n');app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`, resolveDir: '/Users/nallylin/Documents/code/dasCowork/desktop-app', loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
})
const status = await new Promise((resolve, reject) => {
  const child = spawn('/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', [bundle], { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', resolve)
})
if (status !== 0) throw new Error('Chart font control failed: ' + status)
