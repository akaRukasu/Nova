import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

test('both mini titlebar buttons remain clickable outside native drag regions at every supported size',
  { timeout: 45000, skip: process.platform !== 'win32' }, async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'nova-mini-controls-'));
    const data = path.join(profile, 'Nova');
    let app;
    try {
      await mkdir(data);
      await writeFile(path.join(data, 'external-apps.json'), JSON.stringify({ nowPlaying: false, discord: false }));
      const installed = process.env.NOVA_QA_EXECUTABLE;
      app = await electron.launch({
        executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(installed ? [] : ['.']), `--user-data-dir=${data}`], env: { ...process.env, APPDATA: profile },
      });
      const main = await app.firstWindow();
      await main.locator('.sidebar').waitFor();
      const openMini = async () => {
        await main.evaluate(() => window.nova.invoke('mini:open'));
        for (let attempt = 0; attempt < 100; attempt++) {
          const mini = app.windows().find(page => page.url().endsWith('#mini'));
          if (mini) { await mini.locator('.mini').waitFor(); return mini; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail('Mini player did not open');
      };
      const checkHits = async mini => {
        const result = await mini.evaluate(() => {
          const root = document.querySelector('.mini');
          const drags = [...root.querySelectorAll('*')].filter(element => getComputedStyle(element).webkitAppRegion === 'drag')
            .map(element => element.getBoundingClientRect());
          const buttons = [...root.querySelectorAll('.mini-window-actions button')];
          return getComputedStyle(root).webkitAppRegion === 'no-drag' && buttons.length === 2 && buttons.every(button => {
            const box = button.getBoundingClientRect();
            const separate = drags.every(drag => drag.right <= box.left || drag.left >= box.right
              || drag.bottom <= box.top || drag.top >= box.bottom);
            return separate && [[box.left + 8, box.top + 8], [box.right - 8, box.bottom - 8],
              [(box.left + box.right) / 2, (box.top + box.bottom) / 2]]
              .every(([x, y]) => document.elementFromPoint(x, y)?.closest('button') === button);
          });
        });
        assert.ok(result, 'Both buttons must have an interactive area with no overlapping native drag rectangle');
      };
      const resize = async (mini, width, height) => {
        await app.evaluate(({ BrowserWindow }, size) => {
          const floating = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#mini'));
          floating.setSize(...size); floating.emit('resized');
        }, [width, height]);
        await mini.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
      };
      const mini = await openMini();
      for (let cycle = 0; cycle < 6; cycle++) {
        await mini.locator('.mini--compact').waitFor();
        await resize(mini, cycle % 2 ? 432 : 360, cycle % 2 ? 176 : 164);
        await checkHits(mini);
        await mini.getByRole('button', { name: 'Afficher la grande pochette' }).click({ position: cycle % 2 ? { x: 8, y: 8 } : { x: 20, y: 20 } });
        await mini.locator('.mini--artwork').waitFor();
        await resize(mini, cycle % 2 ? 384 : 360, cycle % 2 ? 568 : 432);
        await checkHits(mini);
        await mini.getByRole('button', { name: 'Passer au mini lecteur compact' }).click({ position: { x: 32, y: 32 } });
      }
      const closeMini = async mini => {
        await mini.getByRole('button', { name: 'Revenir au grand lecteur' }).click({ position: { x: 8, y: 8 } })
          .catch(error => { if (!mini.isClosed()) throw error; });
        await main.waitForFunction(() => document.visibilityState === 'visible', undefined, { timeout: 5000 });
        assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
          .some(window => !window.webContents.getURL().endsWith('#mini') && window.isVisible())));
      };
      await closeMini(mini);
      const reopened = await openMini();
      await reopened.getByRole('button', { name: 'Afficher la grande pochette' }).click();
      await reopened.locator('.mini--artwork').waitFor();
      await checkHits(reopened);
      await closeMini(reopened);
    } finally {
      await app?.close();
      assert.equal(path.dirname(profile), os.tmpdir());
      assert.ok(path.basename(profile).startsWith('nova-mini-controls-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
  });
