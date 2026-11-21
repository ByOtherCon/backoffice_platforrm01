import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/lib/bidrules.ts';

test('search reaches back 30 days from when a lead was last seen', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.equal(R.withinSearchWindow('2026-10-01T12:00:00Z', now), true); assert.equal(R.withinSearchWindow('2026-09-30T11:59:00Z', now), false);
});
test('ranking: region tier, then shopping centers, then project type', () => {
  const L = (name: string, tier: number, mall: boolean, type: string) => ({ name, gc: 'g', tier, mall, type });
  const sorted = [L('d', 2, true, 'Retail'), L('c', 1, false, 'Office / Medical / Other'), L('b', 1, true, 'Restaurant'), L('a', 1, true, 'Retail'), L('e', 1, false, 'Retail')].sort(R.rankLeads).map((x) => x.name);
  assert.deepEqual(sorted, ['a', 'b', 'e', 'c', 'd']);
});
test('tiers come from the city list; unknown cities are Tier 3', () => {
  assert.equal(R.tierFor('Orlando', { orlando: 1 }), 1); assert.equal(R.tierFor('ST. Cloud', { stcloud: 2 }), 2); assert.equal(R.tierFor('Nowhere', { orlando: 1 }), 3); assert.equal(R.tierFor(null, {}), 3);
  assert.equal(R.looksLikeShoppingCenter('Orlando Premium Outlets', null), true); assert.equal(R.looksLikeShoppingCenter('Freestanding bank, 12 Main St'), false);
});
test('the same job from two GCs is recognised; different units and different cities are not', () => {
  const j = (name: string, city: string, address: string) => ({ name, city, address });
  assert.equal(R.sameJob(j('Aldi - Orlando (New Shell Space)', 'Orlando', '1401 South Hiawassee Road'), j('Aldi - Orlando (New Shell Space)', 'Orlando', '1401 S Hiawassee Rd')), true);
  assert.equal(R.sameJob(j('Sunglass Hut - Lutz', 'Lutz', '2382 Grand Cypress Drive, Suite 983'), j('Sunglass Hut Lutz Premium Outlets', 'Lutz', '2382 Grand Cypress Dr, Ste 983')), true);
  assert.equal(R.sameJob(j('Sunglass Hut', 'Lutz', '2382 Grand Cypress Drive, Suite 983'), j('Sunglass Hut', 'Lutz', '2382 Grand Cypress Drive, Suite 120')), false);
  assert.equal(R.sameJob(j('Wingstop', 'Orlando', ''), j('Wingstop', 'Tampa', '')), false);
  assert.equal(R.sameJob({ name: 'x', city: 'a', address: '', threadId: 't1' }, { name: 'y', city: 'b', address: '', threadId: 't1' }), true);
  assert.equal(R.gcKey('Sun Industrial, Inc.'), R.gcKey('sun industrial'));
});

test('the tier follows the city however it is typed, and a missing or unlisted city is found in the address or name before defaulting to Tier 3', () => {
  const map = { orlando: 1, stcloud: 1, tampa: 2, miami: 3, winterpark: 1 };
  for (const c of ['Orlando', 'orlando', 'Orlando, FL', 'Orlando FL', 'Orlando, Florida 32809', 'ORLANDO, FL 32809']) assert.equal(R.tierFor(c, map), 1, c);
  assert.equal(R.tierFor('St. Cloud, FL', map), 1); assert.equal(R.tierFor('Saint Cloud', map), 1); assert.equal(R.tierFor('Tampa, FL', map), 2);
  // the New Balance case: the city was left empty or typed wrong, the address and name say Orlando
  assert.deepEqual(R.tierWhy('', map, 'New Balance - Orlando, FL', '8001 S Orange Blossom Trl'), { tier: 1, note: 'No city was entered; found orlando in the address or project name: Tier 1' });
  assert.equal(R.tierFor('Orlandoo', map, 'New Balance', '8001 S Orange Blossom Trl, Orlando FL 32809'), 1);
  assert.match(R.tierWhy('Nowhereville', map, 'Retail Store', '1 Main St').note, /"Nowhereville" is not on the city list, so it defaults to Tier 3/);
  assert.match(R.tierWhy('', map, 'Retail Store', '1 Main St').note, /No city was entered/);
});

test('the same job from different GCs is recognised, but two addresses are two jobs', () => {
  const j = (name: string, city: string | null, address: string | null) => ({ name, city, address });
  assert.equal(R.sameJob(j('New Balance - Orlando, FL', 'Orlando', null), j('New Balance Orlando', 'Orlando, FL', null)), true);       // city spelled two ways, no address
  assert.equal(R.sameJob(j('New Balance', 'Orlando', '8001 S Orange Blossom Trl'), j('New Balance (Retail Shell)', 'Orlando FL', '8001 South Orange Blossom Trail')), true);
  assert.equal(R.sameJob(j('Aldi - Orlando', 'Orlando', '100 Colonial Dr'), j('Aldi - Orlando', 'Orlando', '2400 Semoran Blvd')), false);   // same store name, different addresses
  assert.equal(R.sameJob(j('New Balance', 'Orlando', null), j('Aldi', 'Orlando', null)), false);
  assert.equal(R.sameJob(j('New Balance', 'Orlando', null), j('New Balance', 'Tampa', null)), false);
});

test('the same job is recognised when the address is written differently: a place name in front, no street at all, a lettered space number, a missing city', () => {
  const j = (name: string, city: string | null, address: string | null) => ({ name, city, address });
  assert.equal(R.sameJob(j('Old Navy 5904 Refresh - Tampa, FL - Plaza at Citrus Park', 'Tampa', '12851 Citrus Plaza Drive, Tampa, FL 33625'), j('Old Navy 5904 Refresh - Tampa, FL - Plaza at Citrus Park', 'Tampa', 'The Plaza at Citrus Park, 12851 Citrus Plaza Drive, Tampa, FL 33625')), true);
  assert.equal(R.sameJob(j('Abercrombie - Mall at Millenia', 'Orlando', 'Mall at Millenia'), j('Abercrombie - Mall at Millenia - Orlando FL', 'Orlando', '4200 Conroy Road, Space #C-196, Orlando, FL 32839')), true);
  assert.equal(R.sameJob(j('Abercrombie - Mall at Millenia - Orlando FL', 'Orlando', '4200 Conroy Road, Space #C-196, Orlando, FL 32839'), j('Abercrombie & Fitch - Millenia Mall, Orlando FL', null, '4200 Conroy Road, Space #196, Orlando, FL 32839')), true);
  assert.equal(R.sameJob(j('A&F Kids - Mall at Millenia', 'Orlando', '4200 Conroy Road, Space #C-210'), j('Abercrombie - Mall at Millenia', 'Orlando', '4200 Conroy Road, Space #C-196')), false);   // two stores in the same mall
  assert.equal(R.sameJob(j('Wingstop', null, '1 Main St, Tampa, FL'), j('Wingstop', 'Orlando', '1 Main St')), false);   // the one without a city does not mention Orlando
  assert.equal(R.sameJob(j('Aldi', 'Orlando', 'Florida Mall'), j('Publix', 'Orlando', 'Florida Mall')), false);
  assert.equal(R.sameJob(j('Starbucks', 'Orlando', 'Florida Mall'), j('Starbucks', 'Orlando', 'Mall at Millenia')), false);   // the same brand in two malls is two jobs
  assert.equal(R.sameJob(j('Starbucks', 'Orlando', 'Mall at Millenia, Orlando'), j('Starbucks', 'Orlando', 'Millenia Mall')), true);   // a place name alone never makes two names one job
});

test('two stores at the same mall are two jobs: a name that only says where it is (a GC code and the mall) never joins a lead for a named store', () => {
  const j = (name: string, city: string | null, address: string | null) => ({ name, city, address });
  const rm = j('OPP-138227 - RM3543_Mall at Millenia - Orlando, FL', 'Orlando', '4200 Conroy Road, Orlando, FL 32839');
  assert.equal(R.sameJob(rm, j('Abercrombie - Mall at Millenia - Orlando FL', 'Orlando', '4200 Conroy Road, Space #C-196, Orlando, FL 32839')), false);
  assert.equal(R.sameJob(rm, j('Abercrombie - Mall at Millenia', 'Orlando', 'Mall at Millenia')), false);
  assert.equal(R.sameJob(j('Ulta - Mall at Millenia', 'Orlando', '4200 Conroy Road'), j('Abercrombie - Mall at Millenia', 'Orlando', '4200 Conroy Road')), false);
  assert.equal(R.sameJob(j('Wingstop - St Cloud', 'St Cloud', '1200 13th St'), j('Panda Express - St Cloud', 'St Cloud', '1200 13th St')), false);   // a strip center: only the city in common
  assert.equal(R.sameJob(j('Old Navy - Plaza at Citrus Park', 'Tampa', '12851 Citrus Plaza Drive'), j('Ulta - Plaza at Citrus Park', 'Tampa', '12851 Citrus Plaza Drive')), false);
  // the same store, worded differently, is still one job
  assert.equal(R.sameJob(j('Abercrombie - Mall at Millenia', 'Orlando', '4200 Conroy Road'), j('Abercrombie & Fitch - Millenia Mall, Orlando FL', 'Orlando', '4200 Conroy Road, Space #196')), true);
  assert.equal(R.sameJob(j('Sunglass Hut - Lutz', 'Lutz', '2382 Grand Cypress Drive'), j('Sunglass Hut Lutz Premium Outlets', 'Lutz', '2382 Grand Cypress Dr')), true);
  assert.equal(R.sameJob(rm, j('OPP-138227 - RM3543_Mall at Millenia - Orlando, FL', 'Orlando', '4200 Conroy Road')), true);   // the very same invitation again
  assert.deepEqual(R.tenantWords('OPP-138227 - RM3543_Mall at Millenia - Orlando, FL', 'Orlando'), []);
  assert.deepEqual(R.tenantWords('Old Navy 5904 Refresh - Tampa, FL - Plaza at Citrus Park', 'Tampa'), ['old', 'navy', 'refresh']);
  assert.deepEqual(R.tenantWords('Sunglass Hut Lutz Premium Outlets', 'Lutz'), ['sunglass', 'hut']);
  assert.deepEqual(R.tenantWords('Aritzia at Disney Springs', 'Lake Buena Vista'), ['aritzia']);
});

test('A&F is Abercrombie & Fitch; the client a name points to; one street however it is written', () => {
  const j = (name: string, city: string | null, address: string | null) => ({ name, city, address });
  assert.equal(R.sameJob(j('A&F Kids - Mall at Millenia', 'Orlando', '4200 Conroy Road'), j('Abercrombie - Mall at Millenia', 'Orlando', '4200 Conroy Road')), true);
  assert.equal(R.sameJob(j('A&F Kids - Mall at Millenia', 'Orlando', '4200 Conroy Road, Space #D-210'), j('Abercrombie - Mall at Millenia', 'Orlando', '4200 Conroy Road, Space #C-196')), false);   // two spaces: two stores
  assert.deepEqual(['Abercrombie - Mall at Millenia - Orlando FL', 'A&F Kids - Mall at Millenia', 'Old Navy 5904 Refresh - Tampa, FL - Plaza at Citrus Park', 'OPP-138227 - RM3543_Mall at Millenia - Orlando, FL', 'Wingstop - St Cloud'].map((n) => R.clientFromName(n, 'Orlando')),
    ['Abercrombie & Fitch', 'Abercrombie & Fitch', 'Old Navy 5904 Refresh', '', 'Wingstop']);
  assert.equal(R.streetKey('4200 Conroy Rd, Space #C-196, Orlando, FL 32839'), R.streetKey('Mall at Millenia, 4200 Conroy Road')); assert.equal(R.streetKey('Mall at Millenia'), '');
});
