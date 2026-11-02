// ローカル素材だけを127.0.0.1で配信し、通常profileと分けたChromeで比較する。
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, option] = process.argv.slice(2);
if(!directory)throw new Error('評価結果のディレクトリが必要です');
const root=resolve(directory), verify=option==='--verify';
let manifest;
try {
 manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
 if(!Array.isArray(manifest.clips)||!manifest.clips.length)throw new Error('比較区間がありません');
} catch {
 throw new Error('評価結果のmanifest.jsonを読み込めません');
}
const allowed=new Map();
for(const clip of manifest.clips)for(const variant of Object.values(clip.variants)){
 const path=resolve(root,variant.file), part=relative(root,path);
 if(part.startsWith('..')||isAbsolute(part)||!part||extname(path)!=='.wav')throw new Error('評価範囲外のファイルです');
 allowed.set('/'+variant.file.replaceAll('\\','/'),path);
}
const html=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'nr-evaluation-player.html'));
const server=createServer((request,response)=>{
 const path=new URL(request.url,'http://127.0.0.1').pathname;
 if(path==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);}
 else if(path==='/manifest.json'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(manifest));}
 else if(allowed.has(path)){const data=readFileSync(allowed.get(path));response.writeHead(200,{'Content-Type':'audio/wav','Content-Length':data.length});response.end(data);}
 else {response.writeHead(404);response.end();}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({channel:'chrome',headless:verify,...(!verify?{ignoreDefaultArgs:['--mute-audio']}:{})});
 const context=await browser.newContext({permissions:['microphone']});
 const page=await context.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port);
 await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled({timeout:30000});
 if(verify){
  const initial=await page.evaluate(()=>window.auralynNR.snapshot());
  if(initial.playing||initial.contextState==='running')throw new Error('ユーザー操作前に再生されています');
  await page.getByRole('button',{name:'再生',exact:true}).click();
  await page.waitForTimeout(200);
  const before=await page.evaluate(()=>window.auralynNR.snapshot());
  await page.getByRole('button',{name:'現行設定',exact:true}).click();
  const after=await page.evaluate(()=>window.auralynNR.snapshot());
  if(!after.playing||before.startedAt!==after.startedAt||after.position<before.position)throw new Error('候補切替で再生位置が戻りました');
  await page.getByRole('button',{name:'停止',exact:true}).click();
  if((await page.evaluate(()=>window.auralynNR.snapshot())).playing)throw new Error('停止できません');
  const clipChecks=[{index:0,bufferCount:initial.bufferCount}];
  for(let index=1;index<manifest.clips.length;index++){
   await page.locator('#clip').selectOption(String(index));
   await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled();
   const snapshot=await page.evaluate(()=>window.auralynNR.snapshot());
   if(snapshot.playing||snapshot.bufferCount!==4)throw new Error('区間変更後の候補を読み込めません');
   clipChecks.push({index,bufferCount:snapshot.bufferCount});
  }
  await page.screenshot({path:join(root,'player.png')});
  writeFileSync(join(root,'player-verification.json'),JSON.stringify({passed:true,initial,before,after,clipChecks,chromeAudioMutedDuringVerification:true},null,2));
  console.log(JSON.stringify({root,passed:true}));
 }else{
  console.log('NR比較画面を開きました。終了するときはこの専用Chromeを閉じてください。');
  await new Promise(resolve=>browser.once('disconnected',resolve));
 }
}finally{
 if(browser)await browser.close().catch(()=>{});
 await new Promise(resolve=>server.close(resolve));
}
