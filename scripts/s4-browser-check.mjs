import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { browserOptions } from './browser-config.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--(case|mode|out)=(.+)$/);
    if (!m) throw new Error('Unknown option ' + a);
    return m.slice(1);
  }),
);
assert.ok(!args.case || args.case === 'S4-I1', 'No selected browser case');
assert.ok(!args.mode || ['tdm', 'relay'].includes(args.mode), 'Unknown mode');
const out = resolve(args.out || `artifacts/online-s4/browser-${Date.now()}`);
await mkdir(out, { recursive: true });
const release = JSON.parse(await readFile('dist/release.json', 'utf8')),
  results = [];
for (const mode of args.mode ? [args.mode] : ['tdm', 'relay']) {
  const directory = resolve(out, mode);
  await mkdir(directory, { recursive: true });
  const report = { id: 'S4-I1', mode, identity: release.identity, errors: [] };
  const app = createApp({ config: readConfig({ PORT: '0' }), identity: release.identity });
  let browser;
  let rejectAsync;
  const asynchronousFailure = new Promise((_, reject) => {
    rejectAsync = reject;
  });
  const onError = (error) => rejectAsync(error);
  process.on('uncaughtException', onError);
  let timeout;
  try {
    await Promise.race([
      asynchronousFailure,
      new Promise((_, fail) => {
        timeout = setTimeout(() => fail(new Error('S4-I1 timeout')), 120000);
      }),
      (async () => {
        const address = await app.start();
        browser = await chromium.launch(browserOptions());
        report.browser = browser.version();
        const pages = [];
        for (let i = 0; i < 2; i++) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
          await context.addInitScript(() =>
            localStorage.setItem(
              'harbor_after_rain_opts_v1',
              JSON.stringify({ quality: 'low', size: 4, primary: 'm4a1', goal: 100, diff: 'hell' }),
            ),
          );
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          page.on('pageerror', (e) => report.errors.push(e.stack));
          await page.goto(`http://127.0.0.1:${address.port}/?nolock=1&q=low`, {
            waitUntil: 'networkidle',
            timeout: 90000,
          });
          await page.waitForFunction(() => window.__game?.session?.ready);
          pages.push(page);
        }
        const [one, two] = pages;
        report.rules = await one.evaluate(() => ({
          opts: { ...window.__game.opts },
          stored: JSON.parse(localStorage.getItem('harbor_after_rain_opts_v1')),
          customRuleControls: document.querySelectorAll('.seg[data-k="goal"], .seg[data-k="diff"]')
            .length,
          targets: [
            document.querySelector('#tdmTarget').textContent,
            document.querySelector('#relayTarget').textContent,
          ],
        }));
        assert.equal(report.rules.customRuleControls, 0);
        assert.deepEqual(report.rules.targets, ['50', '50']);
        for (const prefs of [report.rules.opts, report.rules.stored]) {
          assert.equal('goal' in prefs, false);
          assert.equal('diff' in prefs, false);
          assert.equal(prefs.primary, 'm4a1');
          assert.equal(prefs.size, 4);
        }
        const layout = async () => {
          const a = await one.locator('#btnStartTdm').boundingBox();
          const b = await one.locator('#btnStartRelay').boundingBox();
          return {
            sideBySide: a.x + a.width <= b.x && Math.abs(a.y - b.y) < 3,
            noOverflow: await one.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          };
        };
        report.layout = { desktop: await layout() };
        assert.ok(report.layout.desktop.sideBySide && report.layout.desktop.noOverflow);
        await one.setViewportSize({ width: 844, height: 390 });
        report.layout.landscape = await layout();
        assert.ok(report.layout.landscape.sideBySide && report.layout.landscape.noOverflow);
        await one.setViewportSize({ width: 1280, height: 800 });
        report.defaultName = await one.locator('#onlineName').inputValue();
        assert.match(report.defaultName, /^港区队员\d{4}$/);
        await one.locator('#onlineName').fill('   ');
        const manualName = '<队员&"测试>';
        await two.locator('#onlineName').fill(manualName);
        await one.screenshot({ path: resolve(directory, 'lobby.png') });
        await one.locator('#createPassword').fill('deck');
        await one.locator(mode === 'tdm' ? '#btnStartTdm' : '#btnStartRelay').click();
        await one.waitForFunction(() => window.__game.player?.alive);
        const room = app.room;
        assert.equal(await one.evaluate(() => window.__game.player.name), report.defaultName);
        assert.equal(await one.locator('#onlineName').inputValue(), report.defaultName);
        assert.equal(room.match.mode, mode);
        assert.equal(room.match.goal, 50);
        assert.equal(await one.evaluate(() => window.__game.goal), 50);
        await two.locator('#refreshRooms').click();
        await two.locator('[data-room-id]').first().click();
        await two.waitForFunction(() =>
          document.querySelector('#roomNotice').textContent.includes('密码不正确'),
        );
        assert.equal(await two.evaluate(() => !!window.__game.player), false);
        await two.locator('#roomList input').fill('deck');
        await two.locator('[data-room-id]').first().click();
        await two.waitForFunction(() => window.__game.player?.alive);
        assert.equal(room.connections.size, 2);
        await one.waitForFunction(
          (name) => window.__game.actors.some((actor) => actor.name === name),
          manualName,
        );
        assert.equal(await two.evaluate(() => window.__game.player.name), manualName);
        report.names = await one.evaluate(() => {
          const g = window.__game;
          g.hud.scoreboard(true, g.actors, g.player.id, g.score);
          const cells = [...document.querySelectorAll('#boardBody tr td:first-child')];
          const expected = g.actors.map(
            (a) => `${a.controlType === 'bot' ? '🤖' : '👤'} ${a.name}`,
          );
          const actual = cells.map((cell) => cell.textContent);
          const bot = g.actors.find((a) => a.controlType === 'bot');
          g.hud.killFeed(g.player, bot, 'm4a1', false, false, true);
          const feed = document.querySelector('#feed .kf');
          g.hud.scoreboard(false);
          return {
            expected,
            actual,
            markupInjected: cells.some((cell) => cell.children.length > 0),
            feed: [feed.querySelector('.k').textContent, feed.querySelector('.v').textContent],
            expectedFeed: [`👤 ${g.player.name}`, `🤖 ${bot.name}`],
          };
        });
        assert.deepEqual([...report.names.actual].sort(), [...report.names.expected].sort());
        assert.equal(report.names.markupInjected, false, 'nicknames remain escaped text');
        assert.deepEqual(report.names.feed, report.names.expectedFeed);
        await one.bringToFront();
        if (await one.evaluate(() => window.__game.localInterrupted))
          await one.locator('#btnResume').click();
        await one.keyboard.press('Digit2');
        await one.waitForFunction(() => window.__game.player.weapon.id === 'deagle');
        await one.waitForFunction(() => window.__game.time >= window.__game.player.readyAt);
        const before = await one.evaluate(() => window.__game.player.weapon.mag);
        await one.mouse.click(640, 400);
        await one.waitForFunction((mag) => window.__game.player.weapon.mag < mag, before);
        await one.keyboard.press('KeyB');
        await one.locator('#loadCards [data-w="awm"]').click();
        await one.waitForFunction(() => window.__game.player.nextPrimary === 'awm');
        await one.locator('#btnLoadClose').click();
        await one.locator('#btnOnlinePause').click();
        await two.waitForFunction(() => window.__game.netPhase === 'paused');
        await two.locator('#btnResume').click();
        await one.waitForFunction(() => window.__game.netPhase === 'running');
        report.beforeRecovery = await one.evaluate(() => {
          const s = window.__game.session;
          window.__recoveryMark = {
            at: window.performance.now(),
            attempts: s.recoveries,
            seq: s.snapshot.snapshotSeq,
          };
          const value = {
            bases: s.bases.size,
            ack: s.baseAck,
            offered: s.offeredBase,
            phase: window.__game.netPhase,
            interrupted: window.__game.localInterrupted,
            visibility: document.visibilityState,
          };
          s.recoverSnapshot();
          return value;
        });
        await one.waitForFunction(
          () => {
            const s = window.__game.session,
              m = window.__recoveryMark;
            return (
              s.recoveries > m.attempts && s.recoveryAt === null && s.snapshot.snapshotSeq > m.seq
            );
          },
          undefined,
          { timeout: 3000 },
        );
        report.recovery = await one.evaluate(() => {
          const s = window.__game.session,
            m = window.__recoveryMark;
          return {
            ms: window.performance.now() - m.at,
            requests: s.recoveries - m.attempts,
            bases: s.bases.size,
            freshBoundary: s.buffer.samples[0].snapshotSeq > m.seq,
            closed: !!s.closed,
          };
        });
        assert.ok(
          report.recovery.ms <= 3000 &&
            report.recovery.requests === 1 &&
            report.recovery.bases <= 2 &&
            report.recovery.freshBoundary &&
            !report.recovery.closed,
        );
        if (mode === 'tdm') {
          await one.bringToFront();
          if (await one.evaluate(() => window.__game.localInterrupted))
            await one.locator('#btnResume').click();
          await one.keyboard.press('Digit4');
          await one.waitForFunction(
            () =>
              window.__game.player.weapon.id === 'he' &&
              window.__game.time >= window.__game.player.readyAt,
          );
          await one.mouse.click(640, 400);
          await one.waitForFunction(() => window.__game.netNades?.size > 0);
          await one.screenshot({ path: resolve(directory, 'grenade.png') });
          await one.waitForFunction(() => window.__game.netNades?.size === 0);
          assert.equal(room.match.events.filter((e) => e.type === 'explosion').length, 1);
          report.grenade = { visible: true, exploded: true };
        }
        report.connectionsBefore = app.clients.size;
        await one.screenshot({ path: resolve(directory, 'playing.png') });
        room.match.time = 180 - 1 / 60; // Prepare the deadline; actual next step settles.
        await Promise.all(
          pages.map((p) => p.waitForFunction(() => window.__game.result?.reason === 'time')),
        );
        assert.equal(app.rooms.size, 0);
        report.resultNames = await one.evaluate(() => ({
          actual: [...document.querySelectorAll('#endTable tr td:first-child')].map(
            (e) => e.textContent,
          ),
          expected: window.__game.result.actors.map(
            (a) => `${a.controlType === 'bot' ? '🤖' : '👤'} ${a.name}`,
          ),
          mvp: document.querySelector('#endMvp span').textContent,
        }));
        assert.deepEqual(
          [...report.resultNames.actual].sort(),
          [...report.resultNames.expected].sort(),
        );
        assert.ok(report.resultNames.expected.includes(report.resultNames.mvp));
        await one.screenshot({ path: resolve(directory, 'result.png') });
        await one.locator('#btnMenu').click();
        await one.waitForFunction(
          () =>
            !window.__game.player && !document.querySelector('#menu').classList.contains('hidden'),
        );
        await one.locator('#createPassword').fill('');
        await one.locator('#btnStartTdm').click();
        await one.waitForFunction(() => window.__game.player?.alive);
        assert.equal(
          app.clients.size,
          report.connectionsBefore,
          'returning to list must reuse transport',
        );
        assert.ok(app.room.id > room.id);
        await one.locator('#btnOnlinePause').click();
        await one.locator('#btnQuit').click();
        await one.waitForFunction(() => !window.__game.player);
        assert.deepEqual(report.errors, []);
        report.passed = true;
      })(),
    ]);
  } catch (error) {
    try {
      report.recoveryDiagnostic = await browser
        .contexts()[0]
        .pages()[0]
        .evaluate(() => {
          const g = window.__game,
            s = g?.session;
          return {
            phase: g?.netPhase,
            interrupted: g?.localInterrupted,
            visibility: document.visibilityState,
            mark: window.__recoveryMark,
            session: s
              ? {
                  closed: s.closed,
                  attempts: s.recoveries,
                  recoveryAt: s.recoveryAt,
                  seq: s.snapshot?.snapshotSeq,
                  ack: s.baseAck,
                  bases: [...s.bases.keys()],
                  failure: s.failure,
                }
              : null,
          };
        });
    } catch {
      /* retain the original failure if the page has already gone */
    }
    report.serverBases = [...app.clients].map((c) => ({
      actorId: c.actorId,
      active: c.activeBase?.seq,
      offered: c.offeredBase?.seq,
      resyncs: c.resyncs,
    }));
    report.failure = error.stack;
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      await browser?.close();
    } finally {
      await app.close();
      process.off('uncaughtException', onError);
      report.cleanup = {
        clients: app.clients.size,
        rooms: app.rooms.size,
        listening: app.server.listening,
      };
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
      results.push(report);
      await writeFile(resolve(out, 'summary.json'), JSON.stringify(results, null, 2));
    }
  }
  console.log(
    JSON.stringify({ id: report.id, mode, passed: report.passed, cleanup: report.cleanup }),
  );
}
