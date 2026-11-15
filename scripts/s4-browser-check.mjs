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
        await one.screenshot({ path: resolve(directory, 'lobby.png') });
        await one.locator('#createPassword').fill('deck');
        await one.locator(mode === 'tdm' ? '#btnStartTdm' : '#btnStartRelay').click();
        await one.waitForFunction(() => window.__game.player?.alive);
        const room = app.room;
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
