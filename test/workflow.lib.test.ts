import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/lib/workflow.ts';

test('status moves: accepted work never returns to New; results and submitting have their own steps', () => {
  assert.deepEqual(W.nextStatuses('New'), ['Reviewing', 'Accepted', 'Declined']);
  assert.equal(W.canMove('Accepted', 'New'), false); assert.equal(W.canMove('Started', 'Reviewing'), false); assert.equal(W.canMove('Reviewing', 'Declined'), false);
  assert.equal(W.canMove('Declined', 'New'), true); assert.equal(W.canMove('Submitted', 'Awarded'), true); assert.equal(W.canMove('Awarded', 'Submitted'), false);
  assert.equal(W.statusName('No Communication'), 'No Communication From GC');
});
test('who sees what', () => {
  assert.deepEqual(['New', 'Reviewing', 'Accepted'].map(W.inBids), [true, false, false]);
  assert.deepEqual(['Reviewing', 'Accepted', 'Started', 'Submitted', 'Decided Not To Submit'].map(W.inProposals), [true, true, true, false, false]);
  assert.deepEqual(['Reviewing', 'Accepted', 'Started', 'Submitted', 'Declined'].map((s) => W.inSubmittals(s, false)), [false, true, true, true, false]);
  assert.equal(W.inSubmittals('Awarded', true), true); assert.equal(W.inSubmittals('Awarded', false), false);
});
test('reasons are required only where the workflow says so', () => {
  assert.deepEqual(['Declined', 'Decided Not To Submit', 'Not Awarded', 'Awarded', 'Started'].map(W.needsReason), [true, true, true, false, false]);
  assert.ok(W.reasonsFor('Not Awarded').includes('Price too high')); assert.deepEqual(W.reasonsFor('Started'), []);
});
test('auto-decline: New after its bid date plus N days, Reviewing plus M days; undated and accepted work never', () => {
  const r = { declineNewDays: 2, declineReviewingDays: 2 };
  assert.equal(W.autoDeclineDue('New', '2026-10-28', '2026-10-29', r), false); assert.equal(W.autoDeclineDue('New', '2026-10-28', '2026-10-30', r), true);
  assert.equal(W.autoDeclineDue('New', '2026-10-28', '2026-10-29', { ...r, declineNewDays: 1 }), true);   // the stricter one-day rule from the PDF is one setting away
  assert.equal(W.autoDeclineDue('Reviewing', '2026-10-28', '2026-10-30', r), true);
  assert.equal(W.autoDeclineDue('New', null, '2030-01-01', r), false);
  for (const s of ['Accepted', 'Started', 'Submitted', 'Declined']) assert.equal(W.autoDeclineDue(s, '2020-01-01', '2026-10-30', r), false);
});
test('addresses: Florida project addresses are checked field by field', () => {
  assert.deepEqual(W.checkAddr({ street: '123 Main St', city: 'Orlando', state: 'fl', zip: '32801' }, { florida: true }), []);
  assert.equal(W.checkAddr({ street: 'Main St', city: 'Orlando', state: 'FL', zip: '32801' }).length, 1);                       // no street number
  assert.match(W.checkAddr({ street: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301' }, { florida: true })[0], /Florida/);
  assert.match(W.checkAddr({ street: '1 A St', city: 'Orlando', state: 'FL', zip: '90210' }, { florida: true })[0], /not in Florida/);
  assert.equal(W.checkAddr({ street: '1 A St', city: 'Atlanta', state: 'GA', zip: '30301' }).length, 0);                      // a GC can be anywhere
  assert.equal(W.checkAddr({ street: '1 A St', city: 'Orlando', state: 'FL', zip: '3280' }).length, 1);
  assert.equal(W.sameAddr({ street: '1 A St ', city: 'orlando', state: 'FL', zip: '32801-1234' }, { street: '1 a st', city: 'Orlando', state: 'FL', zip: '32801' }), true);
  assert.equal(W.addrEmpty({ street: ' ', city: '', zip: null }), true);
});
test('follow-up cadence matches the approved plan: 7 / 3 / 2 / 4 / 2 business days', () => {
  const p = W.followupPlan('2026-10-23', [], { today: '2026-10-23' });
  assert.deepEqual(p.steps.map((s) => s.due), ['2026-11-03', '2026-11-06', '2026-11-10', '2026-11-16', '2026-11-18']);           // Day 7, 10, 12, 16, 18
  assert.deepEqual([p.stage, p.due, p.needsReview], ['First email', '2026-11-03', false]);
});
test('follow-up waits count from the dates things really happened', () => {
  const log = [{ kind: 'First Email Sent', date: '2026-11-04' }, { kind: 'Call 1', date: '2026-11-09' }];
  const p = W.followupPlan('2026-10-23', log, { today: '2026-11-09' });
  assert.deepEqual([p.stage, p.due], ['Call 2', '2026-11-11']);                                                                  // two business days after the real first call
  assert.equal(p.steps[3].due, '2026-11-17'); assert.equal(p.steps[4].due, '2026-11-19');
  const done = [...log, { kind: 'Call 2', date: '2026-11-11' }, { kind: 'Final Email Sent', date: '2026-11-17' }];
  const d = W.followupPlan('2026-10-23', done, { today: '2026-11-18' });
  assert.deepEqual([d.complete, d.closeDue, d.due], [true, false, '2026-11-19']); assert.equal(W.followupPlan('2026-10-23', done, { today: '2026-11-19' }).closeDue, true);
  assert.equal(W.followupPlan('2026-10-23', [{ kind: 'First Email Sent', date: '2026-10-01' }], { today: '2026-11-01' }).stage, 'First email');   // an email dated before the submission is not part of this version
});
test('known start date: the plan is compressed in the approved order, never backdated, and flagged when it cannot fit', () => {
  // Submitted Fri Oct 23, starts Tue Nov 10 -> final contact by Wed Nov 4 (the PDF's own example)
  const p = W.followupPlan('2026-10-23', [], { startDate: '2026-11-10', today: '2026-10-23' });
  assert.equal(p.cutoff, '2026-11-04'); assert.deepEqual(p.steps.map((s) => s.due), ['2026-10-26', '2026-10-29', '2026-11-02', '2026-11-04', '2026-11-06']); assert.equal(p.needsReview, false);
  // a plan that already ends before the cutoff is left alone
  assert.deepEqual(W.followupPlan('2026-10-23', [], { startDate: '2027-01-15', today: '2026-10-23' }).steps.map((s) => s.due), ['2026-11-03', '2026-11-06', '2026-11-10', '2026-11-16', '2026-11-18']);
  // too close to start: needs schedule review, and nothing is moved into the past
  const tight = W.followupPlan('2026-10-23', [], { startDate: '2026-10-30', today: '2026-10-23' }); assert.equal(tight.needsReview, true);
  const late = W.followupPlan('2026-10-23', [{ kind: 'First Email Sent', date: '2026-10-26' }], { startDate: '2026-11-10', today: '2026-11-03' });   // call 1 is overdue
  assert.equal(late.overdue, true); assert.equal(late.needsReview, true);
});
test('message templates fill from the record and report what is missing instead of inventing it', () => {
  const d = W.followupDrafts({ project: 'Aldi - Orlando', address: '1401 S Hiawassee Rd, Orlando, FL 32835', proposalId: 'P10281', submittedDate: '2026-10-23', trades: 'Demolition, Framing & Drywall', gcContact: 'Brandon Lee', estimator: 'Juliana Reyes', estimatorPhone: '407-555-0100', caller: 'Silvia', callerPhone: '407-555-0111' });
  assert.deepEqual(d.missing, []); assert.equal(d.email1.subject, 'Proposal follow-up | Aldi - Orlando | P10281'); assert.match(d.email1.body, /^Hi Brandon,/); assert.match(d.email1.body, /submitted on October 23, 2026 for Aldi - Orlando at 1401 S Hiawassee Rd/);
  assert.match(d.final.subject, /^Re: Proposal follow-up/); assert.match(d.voicemail, /call me at 407-555-0111/); assert.match(d.call, /Brandon Lee/);
  const m = W.followupDrafts({ project: 'X', address: '', proposalId: 'P1', submittedDate: '2026-10-23', trades: '', gcContact: '', estimator: 'J', estimatorPhone: '' });
  assert.deepEqual(m.missing, ['GC contact name', 'project address', 'submitted trades', 'estimator phone']);
});

test('a lead added after its bid date had passed is not auto-declined for that date', () => {
  const r = { declineNewDays: 2, declineReviewingDays: 2 };
  assert.equal(W.autoDeclineDue('New', '2026-10-01', '2026-10-30', r, true), false);   // entered by hand with a past date
  assert.equal(W.autoDeclineDue('New', '2026-10-01', '2026-10-30', r, false), true);
});

test('Tier 3 and 4 leads get the rest of their week, and never less than three working days: nothing is declined before its week is over', () => {
  // arrived Tuesday 11/10: still alive Thursday 11/12 and through Sunday 11/15; declined once the week of 11/16 starts
  for (const today of ['2026-11-10', '2026-11-12', '2026-11-13', '2026-11-15']) assert.equal(W.newLeadExpiry('2026-11-10', 3, today), null, today);
  assert.match(W.newLeadExpiry('2026-11-10', 3, '2026-11-16')!, /end of its week \(arrived 2026-11-10, that week ended 2026-11-15\)/);
  // arrived Friday 11/6: the old rule declined it the next Monday; now it gets the following week as well
  assert.equal(W.newLeadExpiry('2026-11-06', 3, '2026-11-09'), null); assert.equal(W.newLeadExpiry('2026-11-06', 4, '2026-11-13'), null);
  assert.match(W.newLeadExpiry('2026-11-06', 3, '2026-11-16')!, /arrived 2026-11-06, that week ended 2026-11-15/);
  // tiers 1 and 2 only ever expire on the working-day count, and everyone does after 7
  assert.equal(W.newLeadExpiry('2026-11-02', 2, '2026-11-10'), null); assert.match(W.newLeadExpiry('2026-11-02', 2, '2026-11-11')!, /7 working days/);
});
