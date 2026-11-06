const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const dest = path.resolve(root, '../qa');
const samples = process.env.SAMPLE_DIR || path.resolve(__dirname, '../../fixtures');
(async () => {
  await fs.mkdir(dest,{recursive:true});
  const browserType = process.env.BROWSER === 'webkit' ? webkit : chromium;
  const context = await browserType.launchPersistentContext(path.join(dest,process.env.BROWSER === 'webkit' ? 'profile-webkit' : 'profile-chrome'), { ...(process.env.BROWSER === 'webkit' ? {} : {channel:'chrome'}), headless:true, viewport:{width:393,height:852}, acceptDownloads:true });
  try {
    const page = await context.newPage(), errors=[], requests=[];
    page.on('pageerror',error=>{errors.push(error.message); console.log('PAGE ERROR',error.message)});
    page.on('console',msg=>{if(msg.type()==='error')console.log('CONSOLE',msg.text().slice(0,300))});
    page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
    await page.goto('http://127.0.0.1:48721/?source=origin');
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.screenshot({path:path.join(dest,'home-mobile.png'),fullPage:true});
    const names=await fs.readdir(samples);
    const files=Array.from({length:10},(_,i)=>path.join(samples,names.find(n=>new RegExp(`^${i+1}\\.(PNG|JPG)$`).test(n))));
    const began=Date.now();
    await page.locator('#fileInput').setInputFiles(files);
    await page.waitForFunction(async()=>{const {state}=await import('./app.js');return state.items.length===10&&!state.busy&&state.items.every(i=>!['pending','processing'].includes(i.status))},null,{timeout:300000});
    await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pending;await state.pendingRender;});
    const report=await page.evaluate(async()=>{const {state}=await import('./app.js');return {items:state.items.map(i=>({name:i.name,status:i.status,error:i.error,masks:i.masks,lines:i.lines})),results:state.results.map(r=>({width:r.width,height:r.height,error:r.error})),settings:state.settings,status:document.getElementById('statusDetail').textContent,caches:await caches.keys()};});
    report.errors=errors;report.requests=requests;report.elapsedMs=Date.now()-began;
    await fs.writeFile(path.join(dest,`samples-${process.env.BROWSER||'chrome'}.json`),JSON.stringify(report,null,2));
    for(let i=0;i<5;i++){
      const data=await page.evaluate(async index=>{const {state}=await import('./app.js');const r=state.results[index];if(!r?.blob)return null;const data=new Uint8Array(await r.blob.arrayBuffer());let text='';for(let k=0;k<data.length;k+=32768)text+=String.fromCharCode(...data.subarray(k,k+32768));return btoa(text)},i);
      if(data)await fs.writeFile(path.join(dest,`${i*2+1}+${i*2+2}.png`),Buffer.from(data,'base64'));
    }
    await page.screenshot({path:path.join(dest,'results-mobile.png'),fullPage:true});
    console.log(JSON.stringify({elapsedMs:report.elapsedMs,items:report.items.map(i=>({name:i.name,status:i.status,error:i.error,masks:i.masks})),results:report.results,errors},null,2));
  } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
