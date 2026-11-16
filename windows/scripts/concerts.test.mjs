import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConcerts, searchConcerts } from '../dist/main/concerts.js';

const future = new Date(Date.now() + 80 * 86_400_000);
const date = future.toISOString().slice(0, 10);
const tulle = {
  id: 'tm:31', name: 'ULTRA VOMIT', date: `${date}T19:30:00Z`,
  place: 'Salle polyvalente de l’Auzelou', city: 'Tulle', source: 'Ticketmaster',
};
const openDate = {
  uid: '1198102', title_fr: 'Ultra Vomit à Tulle', location_city: 'Tulle', location_name: "Salle de l'Auzelou",
  timings: JSON.stringify([{ begin: `${date}T20:30:00+01:00` }]),
  registration: JSON.stringify([{ value: 'https://shotgun.live/events/ultra-vomit-a-tulle' }]),
};

test('concert search catches an event absent from the Ticketmaster artist ID and checks later pages', async () => {
  let checkedNext = false;
  const result = await searchConcerts({artist:'Ultra Vomit',city:'Tulle',key:'mock-key'}, async address => {
    const url = new URL(address);
    if (url.hostname === 'public.opendatasoft.com') {
      assert.match(url.searchParams.get('where'), /search\(title_fr, "Ultra Vomit"\).*location_city = "Tulle"/);
      assert.equal(url.searchParams.has('apikey'), false);
      return Response.json({total_count:1,results:[openDate]});
    }
    if (url.pathname.endsWith('attractions.json')) return Response.json({_embedded:{attractions:[{id:'a',name:'ULTRA VOMIT'}]}});
    if (url.searchParams.get('keyword')) {
      assert.equal(url.searchParams.has('classificationName'), false);
      return Response.json({page:{totalPages:1},_embedded:{events:[]}});
    }
    if (url.searchParams.get('page') === '1') {
      checkedNext = true;
      return Response.json({page:{totalPages:2},_embedded:{events:[{
        id:'tm:other',name:'Ultra Vomit',dates:{start:{dateTime:`${date}T20:00:00Z`}},
        _embedded:{venues:[{name:'Autre salle',city:{name:'Autre ville'}}]},
      }]}});
    }
    return Response.json({page:{totalPages:2},_embedded:{events:[]}});
  });
  assert.equal(checkedNext,true);
  assert.equal(result.length,2);
  const event=result.find(event=>event.city==='Tulle');
  assert.equal(event.source,'OpenAgenda');
  assert.equal(event.url,'https://shotgun.live/events/ultra-vomit-a-tulle');
  assert.equal(new Date(event.date).getTime(),new Date(tulle.date).getTime());
});

test('the same concert is listed once and a different session remains visible', () => {
  const partners = [{...tulle,id:'oa:first',name:'Ultra Vomit à Tulle',place:"Salle de l'Auzelou",source:'OpenAgenda',url:'https://example.com/date'},
    {...tulle,id:'oa:other',date:`${date}T16:00:00Z`,source:'OpenAgenda'}];
  const result=mergeConcerts([[tulle],partners]);
  assert.deepEqual(result.map(event=>event.id),['oa:other','tm:31']);
  assert.equal(result[1].url,'https://example.com/date');
  assert.equal(tulle.url,undefined);
});
