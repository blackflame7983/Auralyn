// 利用者指定の配信から短区間の復号済みPCMだけを採取する。通常profile・micは使わない。
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const [directory, suppliedUrl, ...positionValues]=process.argv.slice(2);
const root=resolve(directory),url=new URL(suppliedUrl),positions=positionValues.length?positionValues.map(Number):[300,1500,3000];
if(url.protocol!=='https:'||!['youtube.com','www.youtube.com'].includes(url.hostname)||!/^[\w-]{11}$/.test(url.searchParams.get('v')??'')||positions.some(p=>!Number.isFinite(p)||p<0))throw new Error('動画URL・区間が不正です');
mkdirSync(root,{recursive:false});
const browser=await chromium.launch({channel:'chrome',headless:true}); // 既定の--mute-audioを保持する。
const summary={passed:false,url:url.href,originalNr:'unknown',microphoneOpened:false,physicalPlaybackMuted:true,clips:[]};
try{
 for(const [index,position] of positions.entries()){
  const page=await browser.newPage();const requested=new URL(url);requested.searchParams.set('t',position+'s');
  await page.goto(requested.href,{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForSelector('video',{timeout:30000});await page.locator('video').click({force:true});
  await page.waitForFunction(position=>{const v=document.querySelector('video');return v.readyState>=2&&!v.paused&&v.currentTime>=position&&v.currentTime<position+30&&v.duration>position+10;},position,{timeout:45000});
  const recording=await page.evaluate(async()=>{
   const video=document.querySelector('video'),player=document.querySelector('#movie_player');
   const stream=video.captureStream(),tracks=stream.getAudioTracks();
   if(!tracks.length)throw new Error('本編の音声trackを取得できません');
   const context=new AudioContext({sampleRate:48000});await context.resume();
   const source=context.createMediaStreamSource(new MediaStream(tracks));
   const processor=context.createScriptProcessor(4096,2,2),silence=context.createGain();silence.gain.value=0;
   source.connect(processor);processor.connect(silence);silence.connect(context.destination);
   const samples=new Float32Array(48000*10*2);let frame=0,peak=0;
   const start=video.currentTime;
   try{
    await new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(new Error('音声PCMの取得が期限切れです')),20000);
     processor.onaudioprocess=event=>{
      const left=event.inputBuffer.getChannelData(0),right=event.inputBuffer.getChannelData(Math.min(1,event.inputBuffer.numberOfChannels-1));
      for(let i=0;i<left.length&&frame<480000;i++,frame++){samples[frame*2]=left[i];samples[frame*2+1]=right[i];peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));}
      if(frame===480000){clearTimeout(timer);processor.onaudioprocess=null;resolve();}
     };
    });
   }finally{processor.disconnect();source.disconnect();for(const track of tracks)track.stop();await context.close();video.pause();}
   if(!Number.isFinite(peak)||peak<=1e-5)throw new Error('取得した音声が無音または不正です');
   const bytes=new Uint8Array(samples.buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
   return {base64:btoa(binary),peak,frames:frame,sampleRate:48000,actualStartSeconds:start,title:document.title,videoId:player.getVideoData().video_id};
  });
  if(recording.videoId!==url.searchParams.get('v'))throw new Error('指定動画の本編ではありません');
  const data=Buffer.from(recording.base64,'base64'),header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);
  header.writeUInt16LE(3,20);header.writeUInt16LE(2,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(384000,28);header.writeUInt16LE(8,32);header.writeUInt16LE(32,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  const file='clip-'+(index+1)+'-raw.wav',wav=Buffer.concat([header,data]);writeFileSync(join(root,file),wav);
  const {base64,...metadata}=recording;summary.clips.push({...metadata,index:index+1,requestedPositionSeconds:position,file,sha256:createHash('sha256').update(wav).digest('hex')});
  console.log(JSON.stringify({clip:index+1,peak:recording.peak,frames:recording.frames}));await page.close();
 }
 summary.passed=true;
}catch(error){summary.error=String(error);process.exitCode=1;console.log(JSON.stringify({passed:false,error:summary.error}));}
finally{await browser.close();writeFileSync(join(root,'source.json'),JSON.stringify(summary,null,2));}
