import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, stageFor } from '../src/lib/compliance.ts';
const none = { present: false, expires: null };
const T = '2026-10-31';

test('no documents: missing, cannot be paid', () => {
  const r = evaluate({ w9: false, coi: none, exemption: none }, T);
  assert.equal(r.status, 'Missing'); assert.equal(r.canPay, false); assert.equal(r.reasons.length, 2);
});
test('W-9 alone is not enough; insurance alone is not enough', () => {
  assert.equal(evaluate({ w9: true, coi: none, exemption: none }, T).canPay, false);
  assert.equal(evaluate({ w9: false, coi: { present: true, expires: '2027-01-01' }, exemption: none }, T).canPay, false);
});
test('W-9 plus a current COI is payable; a COI expiring within 30 days is flagged but still payable', () => {
  assert.deepEqual(evaluate({ w9: true, coi: { present: true, expires: '2027-06-01' }, exemption: none }, T).status, 'Valid');
  const soon = evaluate({ w9: true, coi: { present: true, expires: '2026-11-15' }, exemption: none }, T);
  assert.deepEqual([soon.status, soon.canPay, soon.daysLeft], ['Expiring', true, 15]);
});
test('expired COI blocks payment; COI with no expiration date is not accepted', () => {
  const e = evaluate({ w9: true, coi: { present: true, expires: '2026-10-30' }, exemption: none }, T);
  assert.deepEqual([e.status, e.canPay], ['Expired', false]); assert.match(e.reasons[0], /expired 2026-10-30/);
  assert.equal(evaluate({ w9: true, coi: { present: true, expires: null }, exemption: none }, T).canPay, false);
});
test('a workers comp exemption can stand in for a COI', () => {
  assert.equal(evaluate({ w9: true, coi: none, exemption: { present: true, expires: null } }, T).canPay, true);
  assert.equal(evaluate({ w9: true, coi: none, exemption: { present: true, expires: '2026-01-01' } }, T).canPay, false);
  // expired COI but a current exemption: payable
  assert.equal(evaluate({ w9: true, coi: { present: true, expires: '2025-01-01' }, exemption: { present: true, expires: '2027-01-01' } }, T).canPay, true);
});
test('an expiry exactly today is still valid; the day after is not', () => {
  assert.equal(evaluate({ w9: true, coi: { present: true, expires: T }, exemption: none }, T).canPay, true);
  assert.equal(evaluate({ w9: true, coi: { present: true, expires: T }, exemption: none }, '2026-11-01').canPay, false);
});
test('reminder stages', () => {
  assert.equal(stageFor(20, 'Expiring'), 'd30'); assert.equal(stageFor(7, 'Expiring'), 'd7'); assert.equal(stageFor(null, 'Expired'), 'expired'); assert.equal(stageFor(null, 'Valid'), null);
});
