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
