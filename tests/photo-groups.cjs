const assert = require('node:assert/strict');

async function selectGroupMode(page, mode) {
  const radio = page.locator(`input[name="groupMode"][value="${mode}"]`);
  if (!(await radio.isChecked())) {
    await page.locator('label').filter({ has: radio }).click();
    assert.equal(await radio.isChecked(), true);
  }
}

// Use the same grouping controls a user sees after selecting the original fixtures.
async function groupBySizes(page, sizes) {
  await selectGroupMode(page, 'custom');
  const photos = page.locator('#photoList [data-photo-group]');
  let start = sizes[0];
  for (const size of sizes.slice(1)) {
    const first = photos.nth(start);
    await first.selectOption('new');
    const id = await first.inputValue();
    for (let index = 1; index < size; index++) await photos.nth(start + index).selectOption(id);
    start += size;
  }
  await page.evaluate(async () => { await (await import('./app.js')).state.pendingRender; });
}

module.exports = { selectGroupMode, groupBySizes };
