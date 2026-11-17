import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../Nova/Resources/nova-octave-library.js', import.meta.url), 'utf8');
const track = id => ({id,title:'Song '+id,artist:{id:7,name:'Artist'},duration:120,album:{id:8,title:'Album',cover_big:'https://example.com/cover.jpg'}});

function setup({connected=true,pending=false}={}) {
  let pulled=0,synced=0,albumAdds=0;
  const account = {userId:connected?'qa-user':null,dirty:false};
  Object.defineProperty(account,'key',{get(){throw new Error('Credentials must never be inspected');}});
  const liked = new Map(Array.from({length:650},(_,id)=>[id+1,track(id+1)]));
  const state = {playlists:[{id:'liked',tracks:[...liked.values()]}],recentTracks:[track(1)],trackMeta:{1:track(1)},
    savedAlbums:[],followedArtists:[],likeTracks(items){
      for(const item of items){assert.equal(item.album.tracks,undefined);liked.set(item.id,item);}
      state.playlists[0].tracks=[...liked.values()]; account.dirty=true;
    },isAlbumSaved(id){return state.savedAlbums.some(album=>album.id===id);},
    toggleSaveAlbum(album){albumAdds++;state.savedAlbums.push(album);account.dirty=true;}};
  const modules = {
    26029:{libraryReady:Promise.resolve(),useLibrary:{getState:()=>state}},
    88836:{async syncToDevice(){pulled++;},async syncNow(){synced++;account.dirty=pending;}},
    67790:{useAccount:{getState:()=>account}},
  };
  const factories=new Map();
  const window={TURBOPACK:{push(chunk){
    if(typeof chunk[1]==='number') factories.set(chunk[1],chunk[2]);
    else for(const id of chunk[1].runtimeModuleIds) factories.get(id)({i:id=>modules[id]});
  }}};
  runInNewContext(source,{window,location:{origin:'https://music.octavestreaming.com'},setTimeout,clearTimeout,
    fetch:async url=>{assert.equal(url,'https://api.octavestreaming.com/api/album/8');return Response.json({album:{id:8,title:'Album',tracks:[track(900)]}});}});
  async function run(args){
    const {job}=window.novaOctaveLibrary(args);
    for(let i=0;i<100;i++){
      await new Promise(resolve=>setTimeout(resolve,1));
      const result=window.novaOctaveLibrary({operation:'result',job});
      if(!result.running)return result;
    }
    throw new Error('Job did not finish');
  }
  return {run,call:window.novaOctaveLibrary,state,counts:()=>({pulled,synced,albumAdds})};
}

test('official library snapshots paginate and deduplicate without reading account credentials',async()=>{
  const sdk=setup();
  const {value,error}=await sdk.run({operation:'refresh'});
  assert.equal(error,undefined);assert.equal(value.tracks,650);assert.equal(value.connected,true);
  assert.equal(value.libraryAlbums,1);assert.equal(value.libraryArtists,1);assert.equal(value.playlists,0);
  assert.equal(sdk.call({operation:'page',offset:0}).tracks.length,300);
  assert.equal(sdk.call({operation:'page',offset:600}).tracks.length,50);
  assert.equal(sdk.call({operation:'page',offset:0}).tracks[0].albumId,'octave:8');
  const repeated=await sdk.run({operation:'refresh'});
  assert.equal(repeated.value.updatedAt,value.updatedAt);
  assert.equal(sdk.counts().pulled,1);
  sdk.state.playlists.push({id:'imported',tracks:[{...track(901),artist:{id:99,name:'Another Artist'},album:{id:77,title:'Another Album'}}]});
  const refreshed=await sdk.run({operation:'refresh'});
  assert.equal(refreshed.value.tracks,651);assert.equal(refreshed.value.libraryAlbums,2);
  assert.equal(refreshed.value.libraryArtists,2);assert.equal(refreshed.value.playlists,1);
});

test('additions use idempotent client methods and preserve unrelated library tracks',async()=>{
  const sdk=setup();
  for(let attempt=0;attempt<2;attempt++){
    const result=await sdk.run({operation:'add',tracks:[{id:'octave:900',albumId:'octave:8'}],albums:['octave:8']});
    assert.equal(result.error,undefined);assert.equal(result.value.pending,false);
  }
  assert.equal(sdk.state.playlists[0].tracks.length,651);
  assert.equal(sdk.counts().albumAdds,1);assert.equal(sdk.counts().synced,2);
});

test('a disconnected account or unresolved ID is reported and a pending cloud write is not acknowledged',async()=>{
  const disconnected=setup({connected:false});
  assert.match((await disconnected.run({operation:'add',albums:['octave:8']})).error,/Connecte/);
  assert.equal(disconnected.counts().synced,0);
  const sdk=setup({pending:true});
  assert.match((await sdk.run({operation:'add',tracks:[{id:'youtube',albumId:'octave:8'}]})).error,/identifié/);
  const result=await sdk.run({operation:'add',tracks:[{id:'octave:900',albumId:'octave:8'}]});
  assert.equal(result.value.pending,true);
});
