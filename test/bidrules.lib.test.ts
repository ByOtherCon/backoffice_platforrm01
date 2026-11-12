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
