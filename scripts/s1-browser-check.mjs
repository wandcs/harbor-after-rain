import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { browserOptions, browserUrl } from './browser-config.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const out = resolve(option('--out', 'artifacts/online-s1/browser'));
const file = option('--file', null);
const target = file
  ? `${pathToFileURL(resolve(file)).href}?nolock=1&q=low`
  : browserUrl('?nolock=1&q=low');
await mkdir(out, { recursive: true });
const browser = await chromium.launch(browserOptions());
const report = {
  target,
  browser: browser.version(),
  viewport: [1440, 900],
  errors: [],
  externalRequests: [],
  sockets: [],
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (file) {
    await context.setOffline(true);
    await context.route(/^https?:/, (route) => {
      report.externalRequests.push(route.request().url());
      return route.abort();
    });
  }
  const page = await context.newPage();
  page.on('websocket', (socket) => report.sockets.push(socket.url()));
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text());
  });
  await page.goto(target, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__game?.nav && window.__game?.hud?.el?.btnStartTdm, {
    timeout: 90000,
  });
  await page.screenshot({ path: resolve(out, 'menu.png') });
  await page.locator('#btnStartTdm').click();
  await page.waitForFunction(() => window.__game?.player?.alive);
  const read = () =>
    page.evaluate(() => {
      const g = window.__game;
      return {
        position: g.player.pos.toArray(),
        mag: g.player.weapon.mag,
        shots: g.player.stats.shots,
        hp: g.player.hp,
        time: g.time,
        paused: g.paused,
        primary: g.player.primary,
        playing: g.playing,
      };
    });
  const before = await read();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');
  const moved = await read();
  assert.ok(
    Math.hypot(moved.position[0] - before.position[0], moved.position[2] - before.position[2]) >
      0.1,
  );
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const fired = await read();
  assert.ok(fired.shots > moved.shots && fired.mag < moved.mag);
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => window.__game.player.weapon.reloading);
  await page.waitForFunction(() => !window.__game.player.weapon.reloading, { timeout: 8000 });
  const reloaded = await read();
  assert.ok(reloaded.mag > fired.mag);
  await page.keyboard.press('Escape');
  const paused = await read();
  assert.equal(paused.paused, true);
  await page.waitForTimeout(300);
  assert.equal((await read()).time, paused.time);
  await page.locator('#btnResume').click();
  await page.waitForFunction((time) => window.__game.time > time, paused.time);
  await page.screenshot({ path: resolve(out, 'gameplay.png') });
  report.operations = { before, moved, fired, reloaded, paused, resumed: await read() };
  await page.keyboard.press('Escape');
  await page.locator('#btnQuit').click();
  await page.waitForFunction(() => !window.__game.playing);
  await page.locator('#btnStartRelay').click();
  await page.waitForFunction(() => window.__game.playing && window.__game.mode === 'relay');
  report.restarted = await read();
  assert.equal(report.restarted.shots, 0);
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  assert.equal(report.externalRequests.length, 0);
  assert.equal(report.sockets.length, 0);
} finally {
  await browser.close();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
