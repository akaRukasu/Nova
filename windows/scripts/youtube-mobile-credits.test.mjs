import test from 'node:test';
import assert from 'node:assert/strict';
import {trackFrom} from '../dist/main/yt.js';

test('mobile YouTube song credits remain identifiable when they move to another column', () => {
  const link = (text, browseId) => ({text, endpoint:{payload:{browseId}}});
  const item = {type:'MusicResponsiveListItem',item_type:'song',id:'dFUFjrnykU0',title:'...Baby One More Time',
    artists:[],duration:{seconds:228},flex_columns:[{title:{runs:[]}},{title:{runs:[{text:'Titre'}]}},
      {title:{runs:[link('First to Eleven','UC-artist'),{text:' • '},link('...Baby One More Time','MPREb-album')]}}]};
  const track = trackFrom(item);
  assert.equal(track.artist,'First to Eleven');
  assert.equal(track.artistId,'UC-artist');
  assert.equal(track.albumId,'MPREb-album');
  assert.equal(track.duration,228);
  assert.equal(trackFrom({...item,artists:[{name:'Confirmed credits',channel_id:'UC-confirmed'}]}).artist,'Confirmed credits');
});
