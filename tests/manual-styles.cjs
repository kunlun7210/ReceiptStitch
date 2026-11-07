const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..'), outputs = path.resolve(root, '../../outputs');
const variant = process.env.BROWSER || 'chrome';
let browser, server;
(async () => {
  server = require('../scripts/serve.cjs')(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await (variant === 'webkit' ? webkit : chromium).launch({ ...(variant === 'webkit' ? {} : { channel: 'chrome' }), headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?source=origin`); await page.evaluate(() => navigator.serviceWorker.ready);
  const privacy = await page.evaluate(async () => {
    const { paintMasks } = await import('./processing.js'), results = [];
    for (const style of ['mosaic','solid','smear']) for (const scale of [1,.5,.25]) {
      const render = color => {
        const canvas = document.createElement('canvas'); canvas.width = 480 * scale; canvas.height = 800 * scale;
        const g = canvas.getContext('2d', { willReadFrequently: true }); g.fillStyle = color; g.fillRect(0,0,canvas.width,canvas.height);
        paintMasks(g,[{x:48,y:48,width:384,height:672,kind:'manual',source:'manual',style}],scale);
        return { canvas, pixels:g.getImageData(48*scale,48*scale,384*scale,672*scale).data, outside:[...g.getImageData(47*scale|0,48*scale,1,1).data] };
      };
      const a=render('red'),b=render('blue'),colors=new Set();
      if(!a.pixels.every((value,index)=>value===b.pixels[index]))throw Error('Style leaks source pixels: '+style);
      for(let i=0;i<a.pixels.length;i+=4){if(a.pixels[i]<190||a.pixels[i]>246||a.pixels[i]!==a.pixels[i+1]||a.pixels[i]!==a.pixels[i+2]||a.pixels[i+3]!==255)throw Error('Style has incomplete opaque coverage: '+style);colors.add(a.pixels[i]);}
      if(a.outside[0]!==255||a.outside[1]!==0||a.outside[2]!==0)throw Error('Style draws outside selected area');
      const row=a.pixels.slice(0,384*scale*4),changes=[];
      for(let x=1;x<384*scale;x++)if(row[x*4]!==row[(x-1)*4])changes.push(x);
      if(style==='mosaic'&&!changes.every(x=>x%(24*scale)===0))throw Error('Mosaic is not twice the previous 12px cells');
      if(style==='solid'&&colors.size!==1)throw Error('Solid fill is not uniform');
      if(style==='smear'&&colors.size<3)throw Error('Brush texture missing');
      results.push({style,scale,sourceIndependent:true,opaque:true,uniqueGreys:colors.size});a.canvas.width=b.canvas.width=1;
    }
    return results;
  });
  console.log('PASS',variant,'all styles remain opaque, source independent and confined to the selection at three zoom scales');
  await page.locator('#fileInput').setInputFiles(['1.PNG','2.JPG'].map(name=>path.join(process.env.SAMPLE_DIR,name)));
  await page.waitForFunction(async()=>{const{state}=await import('./app.js');return state.items.length===2&&!state.busy},null,{timeout:180000});
  const wait=()=>page.evaluate(async()=>{const{state}=await import('./app.js');await state.pending;await state.pendingRender});await wait();
  assert.deepEqual(await page.evaluate(async()=>(await import('./app.js')).state.items.map(i=>i.status)),['ready','ready']);
  const automaticBefore=await page.evaluate(async()=>(await import('./app.js')).state.items[1].masks.filter(m=>m.kind!=='manual'));
  await page.locator('[data-result="0"] [data-result-action="right"]').click();
  await page.locator('#editorCanvas').waitFor({ state: 'visible' });
  const box=await page.locator('#editorCanvas').boundingBox(),scale=box.width/1206;
  await page.mouse.move(box.x+60*scale,box.y+600*scale);await page.mouse.down();await page.mouse.move(box.x+1140*scale,box.y+1550*scale,{steps:6});await page.mouse.up();
  await page.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));
  const exports=[],labels={mosaic:'马赛克',solid:'纯色',smear:'涂抹'};
  for(const style of ['mosaic','solid','smear']){
    await page.locator(`[data-mask-style="${style}"]`).click();
    assert.equal(await page.locator(`[data-mask-style="${style}"]`).getAttribute('aria-pressed'),'true');
    const masks=await page.evaluate(async()=>(await import('./app.js')).state.items[1].masks);
    assert.equal(masks.filter(m=>m.kind==='manual').length,1);assert.ok(masks.filter(m=>m.kind==='manual').every(m=>m.style===style));
    assert.deepEqual(masks.filter(m=>m.kind!=='manual'),automaticBefore);
    if(variant==='chrome')await page.locator('#editor').screenshot({path:path.join(outputs,`本地预览-手动遮挡-${labels[style]}.png`),animations:'disabled'});
    for(const width of[320,393]){await page.setViewportSize({width,height:852});const sizes=await page.locator('.mask-style-button').evaluateAll(els=>els.map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})));assert.ok(sizes.every(s=>s.width>60&&s.height>=44));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
    await page.locator('#closeEditor').click();await page.waitForTimeout(100);await wait();
    for(const direction of['horizontal','vertical']){
      await page.locator('#stitchSettings').evaluate(e=>e.open=true);await page.locator(`input[value="${direction}"]`).check();await wait();
      const saving=page.waitForEvent('download');await page.locator('[data-result="0"] [data-result-action="save"]').click();const d=await saving;
      const target=variant==='chrome'?path.join(outputs,`本地验证-手动遮挡-${labels[style]}-${direction==='vertical'?'竖向':'横向'}.png`):path.resolve(root,`../qa/style-${style}-${direction}-${variant}.png`);
      await d.saveAs(target);const bytes=await fs.readFile(target),meta=await sharp(bytes).metadata();
      assert.equal(meta.width,direction==='vertical'?1206:2412);assert.equal(meta.height,direction==='vertical'?5244:2622);
      exports.push({style,direction,width:meta.width,height:meta.height,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    }
    await page.locator('[data-result="0"] [data-result-action="right"]').click();
    await page.locator('#editorCanvas').waitFor({ state: 'visible' });
    assert.equal(await page.locator(`[data-mask-style="${style}"]`).getAttribute('aria-pressed'),'true');
    console.log('PASS',variant,style,'live switch, editor preview, horizontal/vertical download and reopening preserve style');
  }
  assert.equal(new Set(exports.map(e=>e.sha256)).size,6);
  await page.locator('#closeEditor').click();await page.reload();
  assert.equal(await page.evaluate(async()=>(await import('./app.js')).state.manualMaskStyle),'smear');assert.deepEqual(errors,[]);
  await fs.writeFile(path.resolve(root,`../qa/manual-styles-${variant}.json`),JSON.stringify({variant,privacy,exports,preferredStylePersists:true,automaticMasksUnchanged:true,errors,physicalIPhoneTested:false},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.close()});
