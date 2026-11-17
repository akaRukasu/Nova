import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { LocalAudioLibrary } from '../dist/main/localAudio.js';
import { defaultSettings } from '../dist/shared/types.js';

test('OBS uses the player’s resolved cover, follows its colours and shows elapsed and total time in a compact frame',
  { timeout: 60000, skip: process.platform !== 'win32' }, async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'nova-obs-ui-'));
    const data = path.join(profile, 'Nova');
    const local = path.join(data, 'LocalAudio');
    let app, page, overlay, origin;
    try {
      const store = new LocalAudioLibrary(() => local);
      const tracks = [];
      for (const [index, title] of ['...Baby One More Time', 'Un autre morceau'].entries()) {
        const wav = Buffer.alloc(44 + 8000 * 2 * 200);
        wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
        for (let sample = 0; sample < 8000 * 200; sample++) wav.writeInt16LE(Math.round(Math.sin(sample * Math.PI * 440 / 8000) * 500), 44 + sample * 2);
        wav[wav.length - 1] = index;
        const file = path.join(profile, `Artiste QA - ${title}.wav`);
        await writeFile(file, wav);
        const imported = await store.import([file]);
        assert.equal(imported.errors.length, 0);
        tracks.push({ ...imported.tracks[0], square: false, artwork: 'https://i.ytimg.com/vi/LiCDZYfAMdo/hqdefault.jpg' });
      }
      await writeFile(path.join(data, 'library.json'), JSON.stringify({
        recents: [], liked: [], added: tracks, playlists: [], saved: [], searches: [], stats: {},
        settings: { ...defaultSettings, autoplayRadio: false, transition: 'off' },
      }));
      await writeFile(path.join(data, 'external-apps.json'), JSON.stringify({ nowPlaying: true, discord: false }));
      const installed = process.env.NOVA_QA_EXECUTABLE;
      app = await electron.launch({
        executablePath: installed || path.resolve('node_modules/electron/dist/electron.exe'),
        args: [...(installed ? [] : ['.']), `--user-data-dir=${data}`], env: { ...process.env, APPDATA: profile },
      });
      page = await app.firstWindow();
      page.on('pageerror', error => console.error('Nova page error:', error.message));
      await page.locator('.sidebar').waitFor();
      for (const [index, track] of tracks.entries()) {
        // Wide cover with a blue/red centre: OBS and the player must use the same square crop.
        const png = await app.evaluate(({ nativeImage }, colour) => {
          const pixels = Buffer.alloc(128 * 64 * 4);
          for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
            const at = (y * 128 + x) * 4;
            const rgb = x < 32 || x >= 96 ? [10, 220, 40] : colour;
            pixels[at] = rgb[2]; pixels[at + 1] = rgb[1]; pixels[at + 2] = rgb[0]; pixels[at + 3] = 255;
          }
          return nativeImage.createFromBitmap(pixels, { width: 128, height: 64 }).toPNG().toString('base64');
        }, index ? [220, 40, 25] : [20, 70, 230]);
        await writeFile(path.join(local, track.id.slice(6) + '.cover'), Buffer.from(png, 'base64'));
      }
      await page.evaluate(values => localStorage.setItem('artworks', JSON.stringify(values)),
        tracks.map(track => [track.id, 'nova-stream://cover/' + track.id.slice(6)]));
      await page.reload();
      await page.locator('.sidebar').waitFor();
      const status = await page.evaluate(() => window.nova.invoke('external:status'));
      assert.ok(status.obsURL);
      origin = new URL(status.obsURL).origin;
      const opened = app.waitForEvent('window');
      await app.evaluate(({ BrowserWindow }, url) => {
        const overlay = new BrowserWindow({ width: 400, height: 100, frame: false, show: false,
          webPreferences: { backgroundThrottling: false } });
        void overlay.loadURL(url);
      }, status.obsURL);
      overlay = await opened;
      overlay.on('pageerror', error => console.error('Overlay page error:', error.message));
      for (const [index, track] of tracks.entries()) {
        await page.evaluate(value => { window.novaPlayer.setVolume(0); window.novaPlayer.play([value]); }, track);
        await page.waitForFunction(() => window.novaPlayer.deck.currentTime > .25);
        await page.evaluate(() => window.novaPlayer.seek(69));
        await overlay.getByRole('heading', { name: track.title, exact: true }).waitFor({ timeout: 10000 });
        await overlay.waitForFunction(isRed => {
          const accent = document.querySelector('.track').style.getPropertyValue('--accent').trim().split(' ').map(Number);
          return accent.length === 3 && (isRed ? accent[0] > accent[2] * 2 : accent[2] > accent[0] * 2);
        }, !!index);
        assert.equal(await page.locator('.player-bar .now-art img').getAttribute('src'), 'nova-stream://cover/' + track.id.slice(6));
        assert.equal(await overlay.getByLabel('Durée totale').textContent(), '3:20');
        await overlay.waitForFunction(() => document.querySelector('.elapsed').textContent.startsWith('1:'));
        assert.match(await overlay.getByLabel('Temps écoulé').textContent(), /^1:(09|1\d)$/);
        const layout = await overlay.locator('.track').boundingBox();
        assert.equal(layout.width, 388);
        assert.ok(layout.height <= 88);
        assert.equal(await overlay.evaluate(() => document.documentElement.scrollHeight), 100);
        const bitmap = await app.evaluate(({ nativeImage }, cover) => {
          const image = nativeImage.createFromBuffer(Buffer.from(cover, 'base64'));
          return { size: image.getSize(), first: [...image.toBitmap().subarray(0, 4)] };
        }, Buffer.from(await (await fetch(origin + '/cover.png')).arrayBuffer()).toString('base64'));
        assert.deepEqual(bitmap.size, { width: 400, height: 400 });
        assert.ok(index ? bitmap.first[2] > bitmap.first[0] * 2 : bitmap.first[0] > bitmap.first[2] * 2);
        await overlay.screenshot({ path: path.join(os.tmpdir(), `nova-obs-0430-${index ? 'red' : 'blue'}.png`), omitBackground: true });
      }
      const cover = Buffer.from(await (await fetch(origin + '/cover.png')).arrayBuffer());
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(await readFile(path.join(data, 'Now Playing', 'cover.png')), cover);
      const miniOpened = app.waitForEvent('window');
      await page.getByRole('button', { name: 'Mini lecteur', exact: true }).click();
      const mini = await miniOpened;
      await mini.locator('.mini--compact').waitFor();
      await mini.getByText(tracks[1].title, { exact: true }).waitFor();
      assert.equal(await mini.locator('.mini-controls button').count(), 7);
      await mini.screenshot({ path: path.join(os.tmpdir(), 'nova-mini-0430-compact.png') });
      await mini.getByRole('button', { name: 'Afficher la grande pochette' }).click();
      await mini.locator('.mini--artwork').waitFor();
      assert.equal(JSON.parse(await readFile(path.join(data, 'mini-player.json'), 'utf8')).layout, 'artwork');
      assert.equal(await mini.locator('.mini-controls button').count(), 7);
      const miniCover = await mini.locator('.mini-art').boundingBox();
      assert.equal(miniCover.width, 320);
      assert.equal(miniCover.height, 320);
      const controlsFit = await mini.locator('.mini-controls').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom <= innerHeight && bounds.right <= innerWidth;
      });
      assert.ok(controlsFit, 'Controls must remain visible in artwork mode');
      await mini.screenshot({ path: path.join(os.tmpdir(), 'nova-mini-0430-artwork.png') });
      await mini.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForFunction(() => window.novaPlayer.deck.paused);
      await mini.getByRole('button', { name: 'Lecture', exact: true }).click();
      await page.waitForFunction(() => !window.novaPlayer.deck.paused);
      const resized = await app.evaluate(({ BrowserWindow }) => {
        const floating = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#mini'));
        const resizable = floating.isResizable();
        floating.setSize(456, 640);
        floating.emit('resized');
        return resizable;
      });
      assert.ok(resized, 'The mini player must allow resizing directly from its edges');
      await mini.waitForFunction(() => innerWidth === 456 && innerHeight === 640);
      assert.ok((await mini.locator('.mini-art').boundingBox()).width > 320);
      await mini.getByRole('button', { name: 'Passer au mini lecteur compact' }).click();
      await mini.locator('.mini--compact').waitFor();
      assert.deepEqual(await mini.evaluate(() => [innerWidth, innerHeight]), [432, 176]);
      await mini.getByRole('button', { name: 'Afficher la grande pochette' }).click();
      await mini.locator('.mini--artwork').waitFor();
      assert.deepEqual(await mini.evaluate(() => [innerWidth, innerHeight]), [456, 640]);
      const closeMini = async target => {
        await target.getByRole('button', { name: 'Revenir au grand lecteur' }).click()
          .catch(error => { if (!target.isClosed()) throw error; });
      };
      await closeMini(mini);
      const reopened = app.waitForEvent('window');
      await page.getByRole('button', { name: 'Mini lecteur', exact: true }).click();
      const remembered = await reopened;
      await remembered.locator('.mini--artwork').waitFor();
      assert.deepEqual(await remembered.evaluate(() => [innerWidth, innerHeight]), [456, 640]);
      await closeMini(remembered);
      await page.getByRole('button', { name: 'Lecteur plein écran', exact: true }).click();
      await page.locator('.now-playing').waitFor();
      await page.screenshot({ path: path.join(os.tmpdir(), 'nova-fullscreen-0430.png'), animations: 'disabled' });
      await page.evaluate(() => window.novaPlayer.pause());
      await overlay.locator('.track').waitFor({ state: 'hidden' });
    } catch (error) {
      console.error('Fixture playback:', await page?.evaluate(() => ({ time: window.novaPlayer.deck.currentTime,
        paused: window.novaPlayer.deck.paused, duration: window.novaPlayer.deck.duration,
        error: document.querySelector('.player-error')?.textContent })).catch(() => null));
      console.error('Fixture overlay state:', origin && await fetch(origin + '/now-playing').then(response => response.json()).catch(() => null));
      throw error;
    } finally {
      await app?.close();
      assert.equal(path.dirname(profile), os.tmpdir());
      assert.ok(path.basename(profile).startsWith('nova-obs-ui-'));
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    }
  });
