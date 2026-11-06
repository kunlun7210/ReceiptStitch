const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const dest = path.resolve(root, '../qa');
const samples = process.env.SAMPLE_DIR || path.resolve(__dirname, '../../fixtures');
const variant = process.env.BROWSER || 'chrome';
let context, server;
(async () => {
  const prefix = process.env.TEST_PREFIX || '/';
  server = require('../scripts/serve.cjs')({basePath:prefix});
  if (process.env.VERIFY_DOWNLOAD_PROGRESS === '1') server.prependListener('request',(req,res) => {
    if (!req.url.includes('/ocr/transport-v1/')) return;
    const end = res.end.bind(res);
    res.end = bytes => {
      let offset = 0, timer;
      const send = () => {
        if (res.destroyed) return;
        if (offset >= bytes.length) return end();
        res.write(bytes.subarray(offset, offset + 65536)); offset += 65536;
        timer = setTimeout(send, 10);
      };
      res.on('close',()=>clearTimeout(timer)); send(); return res;
    };
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}${prefix}`;
  const browserType = variant === 'webkit' ? webkit : chromium;
  context = await browserType.launchPersistentContext(path.join(dest, variant === 'webkit' ? 'profile-webkit' : 'profile-chrome'), { ...(variant === 'webkit' ? {} : {channel:'chrome'}), headless:true, viewport:{width:393,height:852}, acceptDownloads:true });
  const page = await context.newPage(), errors=[], requests=[], passes=[];
  const pass = name => { passes.push(name); console.log('PASS',name); };
  page.on('pageerror',error=>errors.push(error.stack || error.message));
  page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await page.goto(base + '?source=origin');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  // Fresh shell after a service worker update, without losing downloaded models.
  await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
  await page.waitForTimeout(300);
  await page.reload();
  assert.equal(await page.locator('.intro h1').innerText(),'智能隐私拼图');
  assert.equal(await page.locator('.intro p').count(),0);
  await page.locator('#settings').evaluate(el=>el.open=true);
  assert.equal(await page.locator('#colorPalette button').count(),30);
  assert.equal(await page.locator('input[type="color"]').count(),0);
  assert.equal(await page.locator('#fontSize').getAttribute('type'),'range');
  await page.locator('#fontSize').scrollIntoViewIfNeeded();
  const fontSlider = await page.locator('#fontSize').boundingBox();
  await page.mouse.click(fontSlider.x + fontSlider.width * .7, fontSlider.y + fontSlider.height / 2);
  const draggedSize = Number(await page.locator('#fontSize').inputValue());
  assert.ok(draggedSize > 50);
  assert.equal(await page.locator('#fontSizeValue').innerText(),`${draggedSize} pt`);
  await page.locator('#resetSettings').click();
  await page.locator('#openColorPalette').click();
  await page.getByRole('button',{name:'浅红',exact:true}).click();
  assert.equal(await page.locator('#colorLabel').innerText(),'浅红');
  assert.equal(await page.getByRole('button',{name:'浅红',exact:true}).getAttribute('aria-pressed'),'true');
  await page.locator('#closeColorPalette').click();
  await page.locator('#commonColors').getByRole('button',{name:'浅灰',exact:true}).click();
  await page.locator('#settings').screenshot({path:path.join(dest,`palette-${variant}.png`)});
  await page.locator('#settings').evaluate(el=>el.open=false);
  pass('首页文案已替换，常用颜色和二级固定色板可选择，无色号输入和系统颜色器');
  const wait = async count => {
    await page.waitForFunction(async count=>{const {state}=await import('./app.js');return state.items.length===count&&!state.busy},count,{timeout:180000});
    await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pending;await state.pendingRender});
  };
  await page.locator('#helpButton').click();
  assert.equal(await page.locator('#helpDialog').isVisible(),true);
  await page.locator('#closeHelp').click();
  pass('安装帮助可以打开和关闭');
  const files = ['1.PNG','2.JPG','3.PNG','4.PNG','5.JPG','6.PNG','7.PNG','8.PNG','9.PNG','10.PNG'].map(name=>path.join(samples,name));
  await page.evaluate(() => {
    window.downloadEvents = [];
    new MutationObserver(() => {
      const detail = document.getElementById('statusDetail').textContent;
      if (detail.includes('下载识别组件') && detail.includes('MB')) window.downloadEvents.push({detail,value:document.getElementById('progress').value});
    }).observe(document.getElementById('workbench'),{subtree:true,childList:true,attributes:true,attributeFilter:['value']});
  });
  await page.locator('#fileInput').setInputFiles(files);
  await wait(10);
  const detected = await page.evaluate(async()=>{const {state}=await import('./app.js');return state.items.map(item=>({name:item.name,status:item.status,masks:item.masks}));});
  assert.deepEqual(detected.map(i=>i.status),Array(10).fill('ready'));
  assert.deepEqual(detected.map(i=>i.masks.map(m=>m.kind)),[[],['card','balance'],[],['card','balance'],[],['card','balance'],[],['card'],[],['card','balance']]);
  assert.equal(await page.locator('.result-card').count(),5);
  pass('10 张真实素材生成 5 组，5 处尾号和 4 处余额 / 额度全部识别');
  if (process.env.VERIFY_DOWNLOAD_PROGRESS === '1') {
    const progress = await page.evaluate(()=>window.downloadEvents);
    const partial = [...new Set(progress.filter(e=>e.value>0&&e.value<1).map(e=>e.detail))];
    assert.ok(partial.length >= 12,`Download UI did not advance during streamed file: ${partial.length}`);
    await fs.writeFile(path.join(dest,`download-progress-${variant}.json`),JSON.stringify(progress,null,2));
    pass('首次下载过程中实时显示百分比、MB 和进度条');
  }
  if (process.env.OUTPUT_SAMPLES_DIR) {
    await fs.mkdir(process.env.OUTPUT_SAMPLES_DIR,{recursive:true});
    for (let index=0;index<5;index++) {
      const b64 = await page.evaluate(async index => {
        const {state}=await import('./app.js'); const data = new Uint8Array(await state.results[index].blob.arrayBuffer());
        let binary=''; for(let i=0;i<data.length;i+=32768) binary+=String.fromCharCode(...data.subarray(i,i+32768)); return btoa(binary);
      },index);
      await fs.writeFile(path.join(process.env.OUTPUT_SAMPLES_DIR,`${index*2+1}+${index*2+2}.png`),Buffer.from(b64,'base64'));
    }
    await fs.writeFile(path.join(dest,`tight-masks-${variant}.json`),JSON.stringify(detected,null,2));
  }
  // Independently measured inner glyph rectangles from the source images.
  for (const [index,kind,rectangle] of [[1,'card',[457,670,106,34]],[1,'balance',[597,1031,196,34]],[3,'card',[457,685,106,34]],[3,'balance',[597,1046,183,34]],[5,'card',[626,776,96,34]],[5,'balance',[413,956,184,34]],[7,'card',[506,684,90,33]],[9,'card',[618,935,106,34]],[9,'balance',[412,1115,101,34]]]) {
    const [x,y,w,h]=rectangle;
    assert.ok(detected[index].masks.some(m=>m.kind===kind&&m.x<=x&&m.y<=y&&m.x+m.width>=x+w&&m.y+m.height>=y+h),`Uncovered ${index} ${kind}`);
  }
  pass('9 个敏感数字区均被完整遮挡');
  await page.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));
  const downloadEvent=page.waitForEvent('download');
  await page.locator('[data-result="0"] [data-result-action="save"]').click();
  const download=await downloadEvent;
  const downloadPath=path.join(dest,`saved-${variant}.png`);await download.saveAs(downloadPath);
  const metadata=await sharp(downloadPath).metadata();assert.equal(metadata.width,2412);assert.equal(metadata.height,2622);assert.equal(metadata.format,'png');
  pass('实际点击保存导出可解码的完整尺寸 PNG');
  // iOS share invocation is tested with prepared File objects; physical share UI is not emulated.
  await page.evaluate(()=>{window.shared=[];Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:({files})=>{window.shared.push(files.map(f=>({name:f.name,size:f.size,type:f.type})));return Promise.resolve()}});});
  await page.locator('[data-result="0"] [data-result-action="save"]').click();
  await page.locator('#saveAllButton').click();
  const shared=await page.evaluate(()=>window.shared);assert.equal(shared[0].length,1);assert.equal(shared[1].length,5);assert.ok(shared.flat().every(f=>f.size>10000&&f.type==='image/png'));
  pass('单图与批量分享使用提前生成的 File，不丢失点击手势');

  await page.locator('#settings').evaluate(el=>el.open=true);
  await page.locator('#watermarkText').fill('');
  await page.waitForTimeout(400);await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pendingRender});
  const pixelCheck=await page.evaluate(async()=>{
    const {state}=await import('./app.js');const r=state.results[0];const img=new Image();img.src=r.url;await img.decode();const c=document.createElement('canvas');c.width=r.width;c.height=r.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
    const source=document.createElement('canvas');source.width=1206;source.height=2622;const s=source.getContext('2d',{willReadFrequently:true});s.drawImage(state.items[0].image,0,0);
    const a=g.getImageData(0,0,1206,2622).data,b=s.getImageData(0,0,1206,2622).data;let leftDiff=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])leftDiff++;
    s.clearRect(0,0,1206,2622);s.drawImage(state.items[1].image,0,0);
    // Transaction amount ROI, separated from the available balance below it.
    const p=g.getImageData(1206+400,920,660,75).data,q=s.getImageData(400,920,660,75).data;let amountDiff=0;for(let i=0;i<p.length;i++)if(p[i]!==q[i])amountDiff++;
    const {paintMasks}=await import('./processing.js');const red=document.createElement('canvas');red.width=100;red.height=100;const rg=red.getContext('2d');rg.fillStyle='red';rg.fillRect(0,0,100,100);const mask={x:10,y:10,width:70,height:40};paintMasks(rg,[mask]);const before=rg.getImageData(10,10,70,40).data;rg.fillStyle='blue';rg.fillRect(0,0,100,100);paintMasks(rg,[mask]);const after=rg.getImageData(10,10,70,40).data;return{leftDiff,amountDiff,independent:before.every((v,i)=>v===after[i]),outputFirst:[...a.slice(0,16)],sourceFirst:[...b.slice(0,16)],imageSize:[img.naturalWidth,img.naturalHeight],lost:g.isContextLost?.()};
  });
  await fs.writeFile(path.join(dest,`pixel-check-${variant}.json`),JSON.stringify(pixelCheck,null,2));
  const unmarked=await page.evaluate(async()=>{const{state}=await import('./app.js');const a=new Uint8Array(await state.results[0].blob.arrayBuffer());let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s)});
  await fs.writeFile(path.join(dest,`unmarked-${variant}.png`),Buffer.from(unmarked,'base64'));
  assert.equal(pixelCheck.leftDiff,0);assert.equal(pixelCheck.amountDiff,0);assert.equal(pixelCheck.independent,true);
  pass('无水印时左图和交易金额逐像素保留；马赛克像素不携带原文信息');
  await page.locator('#fontSize').fill('60');await page.locator('#transparency').fill('80');
  assert.equal(await page.locator('#fontSizeValue').innerText(),'60 pt');
  await page.locator('#resetSettings').click();
  assert.equal(await page.locator('#fontSize').inputValue(),'50');assert.equal(await page.locator('#transparency').inputValue(),'70');assert.equal(await page.locator('#watermarkText').inputValue(),'机器/收款码办理 详询VX：kunlun7210');
  await page.locator('#settings').evaluate(el=>el.open=false);
  pass('水印设置和恢复默认操作有效');

  await page.locator('[data-result="0"] [data-result-action="right"]').click();
  const area=await page.locator('#editorCanvas').boundingBox();
  await page.mouse.move(area.x+15,area.y+22);await page.mouse.down();await page.mouse.move(area.x+70,area.y+55,{steps:5});await page.mouse.up();
  assert.equal(await page.locator('#maskList .mask-chip').count(),3);
  await page.locator('#undoMask').click();assert.equal(await page.locator('#maskList .mask-chip').count(),2);
  await page.mouse.move(area.x+15,area.y+22);await page.mouse.down();await page.mouse.move(area.x+70,area.y+55,{steps:5});await page.mouse.up();
  await page.locator('#browseMode').click();assert.equal(await page.locator('#browseMode').getAttribute('aria-pressed'),'true');
  await page.locator('#editorZoom').selectOption('2');
  await page.screenshot({path:path.join(dest,`editor-${variant}.png`)});
  await page.locator('#closeEditor').click();await page.waitForTimeout(500);await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pendingRender});
  assert.equal(await page.evaluate(async()=>{const {state}=await import('./app.js');return state.items[1].masks.filter(m=>m.kind==='manual').length}),1);
  assert.match(await page.locator('[data-result="0"] .mask-summary').innerText(),/补框 1 处/);
  pass('拖动补框、撤销、放大和完成检查同步到导出');
  await page.locator('[data-result="0"] [data-result-action="swap"]').click();await page.waitForTimeout(400);await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pendingRender});
  assert.deepEqual(await page.evaluate(async()=>{const {state}=await import('./app.js');return state.items.slice(0,2).map(i=>i.name)}),['2.JPG','1.PNG']);
  await page.locator('.photo-item').nth(1).locator('[data-photo-action="up"]').click();
  assert.deepEqual(await page.evaluate(async()=>{const {state}=await import('./app.js');return state.items.slice(0,2).map(i=>i.name)}),['1.PNG','2.JPG']);
  pass('交换左右和照片前移确实改变配对顺序');
  await page.locator('.photo-item').last().locator('[data-photo-action="remove"]').click();
  await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pendingRender});
  assert.equal(await page.locator('#pairHint').isVisible(),true);assert.match(await page.locator('#pairHint').innerText(),/最后 1 张将单独/);
  assert.equal(await page.locator('.result-card').count(),5);assert.equal(await page.locator('[data-result="4"] [data-result-action="save"]').isEnabled(),true);
  assert.equal(await page.locator('[data-result="4"] [data-result-action="right"]').count(),0);
  pass('奇数张的最后一张单独生成成品并可保存');

  const layouts=[];
  for(const width of [320,375,393,430,768,1280]){
    await page.setViewportSize({width,height:900});const metric=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,button:document.getElementById('addMoreButton').getBoundingClientRect().height}));assert.equal(metric.overflow,false);assert.ok(metric.button>=44);layouts.push({width,...metric});
    if(width===1280)await page.screenshot({path:path.join(dest,`desktop-${variant}.png`),fullPage:true});
  }
  pass('320–1280 像素布局无横向溢出，主要触控目标至少 44 像素');
  await page.setViewportSize({width:393,height:852});
  // Playwright 1.63 / WebKit 2359 rejects SW responses under setOffline(true),
  // even literal Response objects: https://github.com/microsoft/playwright/issues/42775
  // The origin-stopped control tests cache fallback, not an iPhone airplane-mode claim.
  const offlineMode = variant === 'webkit' ? 'origin-server-stopped' : 'browser-offline';
  if (variant === 'webkit') {
    await new Promise(resolve=>server.close(resolve));
    await assert.rejects(fetch(base));
  } else await context.setOffline(true);
  await page.reload();
  await page.locator('#fileInput').setInputFiles(files.slice(8));await wait(2);
  const offline=await page.evaluate(async()=>{const {state}=await import('./app.js');return {ready:state.items.map(i=>i.status),masks:state.items[1].masks.map(m=>m.kind),results:state.results.length,photoCount:state.items.length}});
  assert.deepEqual(offline.ready,['ready','ready']);assert.deepEqual(offline.masks,['card','balance']);assert.equal(offline.results,1);
  pass(variant === 'webkit' ? '来源服务关闭后，缓存启动、真实识别和拼图导出成功' : '断网重新打开后，真实识别和拼图导出成功');
  if (variant === 'webkit') await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  else await context.setOffline(false);
  await page.reload();
  assert.equal(await page.locator('#workbench').isVisible(),false);
  // Force a recoverable OCR start failure; export must require explicit review of both images.
  await page.evaluate(()=>{const real=window.fetch;window.fetch=(url,...args)=>String(url).includes('ocr/manifest.json')?Promise.reject(new Error('test download unavailable')):real(url,...args)});
  await page.locator('#fileInput').setInputFiles(files.slice(0,2));await wait(2);
  assert.equal(await page.locator('[data-result-action="save"]').isDisabled(),true);
  await page.locator('[data-result-action="left"]').click();await page.keyboard.press('Escape');await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-result-action="save"]').isDisabled(),true);
  for(const side of ['left','right']){await page.locator(`[data-result-action="${side}"]`).click();await page.locator('#closeEditor').click();await page.waitForTimeout(250);}
  await page.evaluate(async()=>{const {state}=await import('./app.js');await state.pendingRender});
  assert.equal(await page.locator('[data-result-action="save"]').isDisabled(),false);
  pass('识别失败时禁止直接导出，退出编辑不算完成检查；两图明确检查后可手动继续');
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests.filter(r=>!r.url.startsWith(base)&&!r.url.startsWith('blob:')&&!r.url.startsWith('data:')),[]);
  assert.deepEqual(requests.filter(r=>r.method!=='GET'),[]);
  pass('无页面脚本错误、无外部请求、无上传请求');
  await fs.writeFile(path.join(dest,`browser-${variant}.json`),JSON.stringify({variant,passes,layouts,offline,offlineMode,pixelCheck,errors,requestCount:requests.length,physicalIPhoneTested:false},null,2));
  console.log(`${passes.length} checks passed (${variant})`);
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await context?.close();server?.close()});
