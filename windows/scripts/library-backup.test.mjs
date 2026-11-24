import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPhoneBackup} from '../dist/main/libraryBackup.js';
import {startSyncServer, stopSyncServer, currentPairing, pairingLink, unpair} from '../dist/main/phoneSync.js';
import {defaultSettings} from '../dist/shared/types.js';

const date = 1790000000000;
const song = {id:'pc-backup-song',title:'Titre sauvegardé',artist:'Artiste QA',duration:120,
  album:'Album QA',albumId:'octave:8',artistId:'octave:7',youtubeId:'abcdefghijk',artwork:'https://example.com/cover.jpg'};
const local = {id:'local:'+'a'.repeat(64),title:'Audio local QA',artist:'Artiste QA',
  localFileName:'a'.repeat(64)+'.flac',artwork:'file:///C:/Users/private/cover.jpg'};
const state = {recents:[song],liked:[song],added:[local],
  playlists:[{id:'legacy-playlist-id',name:'Restauration PC QA',tracks:[song,local],created:date-5000,lastPlayedAt:date}],
  smartPlaylists:[{id:'smart-qa',name:'Favoris sauvegardés QA',rules:[{field:'liked',operator:'is',value:'true'}],matchAll:true,sort:'recent'}],
  saved:[{id:'octave:7',kind:'artist',title:'Artiste QA',addedAt:date-5000}],searches:['Artiste QA'],
  stats:{[song.id]:{playCount:7,lastPlayed:date,addedAt:date-5000}},
  listeningYears:{2026:{[song.id]:{track:song,plays:7}}},historyChanges:{removed:{'pc-removed':date}},
  shared:[{id:'shared-qa',title:'Partagée QA',isOwner:false}],
  settings:{...defaultSettings,ticketmasterKey:'private-key-not-in-a-backup'}};

test('the PC backup uses the iPhone schema, preserves dates and annual recap, and excludes private paths and keys', async () => {
  const backup = createPhoneBackup(state,date);
  const text = JSON.stringify(backup);
  assert.equal(backup.library.playlists[0].createdAt,date-5000);
  assert.equal(backup.library.liked[0].youtubeID,'abcdefghijk');
  assert.equal(backup.library.listeningYears[2026][song.id].plays,7);
  assert.equal(backup.library.smartPlaylists[0].rules[0].op,'isTrue');
  assert.equal(backup.library.smartPlaylists[0].sort,'recentlyPlayed');
  assert.ok(!text.includes('private-key') && !text.includes('C:/Users'));
  assert.equal(backup.library.addedTracks[0].localFileName,local.localFileName);
  const fixture=JSON.parse(await fs.readFile(new URL('../../Tools/Fixtures/pc-library-backup.json',import.meta.url),'utf8'));
  assert.deepEqual(JSON.parse(text),fixture,'The same fixture must also be restored by the native iPhone diagnostic');
  const legacy=structuredClone(state);
  delete legacy.playlists[0].created;
  delete legacy.stats[song.id].playCount;
  assert.equal(createPhoneBackup(legacy,date).library.playlists[0].createdAt,date);
  assert.equal(createPhoneBackup(legacy,date).library.stats[song.id].playCount,0);
});

test('the local PC library download requires the pairing token and rejects it after dissociation', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nova-backup-'));
  try {
    await startSyncServer(directory,()=>({playlists:0,tracks:0}),undefined,async()=>createPhoneBackup(state,date));
    const port=new URL(new URL(pairingLink().link).searchParams.get('u')).port;
    const endpoint=`http://127.0.0.1:${port}/library`;
    assert.equal((await fetch(endpoint)).status,403);
    const token=currentPairing().token;
    const response=await fetch(endpoint,{headers:{'X-Nova-Token':token}});
    assert.equal(response.headers.get('cache-control'),'no-store');
    const etag=response.headers.get('etag');
    assert.ok(etag);
    assert.equal((await fetch(endpoint,{headers:{'X-Nova-Token':token,'If-None-Match':etag}})).status,304);
    assert.deepEqual(await response.json(),JSON.parse(JSON.stringify(createPhoneBackup(state,date))));
    assert.equal(currentPairing().paired,true);
    await unpair();
    assert.equal((await fetch(endpoint,{headers:{'X-Nova-Token':token}})).status,403);
  } finally {
    stopSyncServer();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'nova-backup-'));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
