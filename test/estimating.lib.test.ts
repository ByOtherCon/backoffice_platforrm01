import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/lib/estimating.ts';

test('weeks start Monday; business-day math skips weekends', () => {
  assert.equal(E.weekOf('2026-10-28'), '2026-10-26'); assert.equal(E.weekOf('2026-11-01'), '2026-10-26');
  assert.equal(E.businessDays('2026-10-30', '2026-11-03'), 2); assert.equal(E.addBusinessDays('2026-10-30', 1), '2026-11-02'); assert.equal(E.addBusinessDays('2026-10-30', 5), '2026-11-06');
  assert.equal(E.businessDays('2026-11-03', '2026-10-30'), -2);
});
test('countdown labels', () => {
  assert.equal(E.countdown('2026-11-05', false, '2026-11-02'), '3 Business Days Left'); assert.equal(E.countdown('2026-11-02', false, '2026-11-02'), 'Due Today');
  assert.match(E.countdown('2026-10-30', false, '2026-11-02'), /^Overdue · 1 Business Days/); assert.equal(E.countdown(null, false), 'Due Date Needed'); assert.equal(E.countdown('2020-01-01', true), 'Submitted');
});
test('leads drop out two days after their bid date', () => {
  assert.equal(E.expiredLead('2026-10-29', '2026-10-31'), true); assert.equal(E.expiredLead('2026-10-30', '2026-10-31'), false); assert.equal(E.expiredLead(null), false);
});
test('inbox grouping (today = Thu 2026-10-29)', () => {
  const t = '2026-10-29';
  assert.equal(E.groupFor(null, t), 'No Bid Due Date Provided'); assert.equal(E.groupFor('2026-10-27', t), 'Missed / Past Due');
  assert.equal(E.groupFor('2026-10-30', t), 'Due This Week — Too Tight To Bid');       // before next Monday
  assert.equal(E.groupFor('2026-11-03', t), 'Week Of 2026-11-02');                     // Tuesday of next week
  assert.equal(E.groupFor('2026-11-02', t), 'Week Of 2026-11-02');                     // Monday == first forward Monday stays
  assert.equal(E.groupFor('2026-11-09', t), 'Week Of 2026-11-02');                     // later Monday closes the prior week
  assert.equal(E.groupFor('2026-11-12', t), 'Week Of 2026-11-09');
});
test('proposal ids count up per day', () => {
  assert.equal(E.nextProposalId([], '2026-10-28'), 'P10281'); assert.equal(E.nextProposalId(['P10281', 'P10283', 'P10171', null], '2026-10-28'), 'P10284'); assert.equal(E.nextProposalId(['P10281'], '2026-10-29'), 'P10291');
});
test('folder plan and file-safe names', () => {
  const f = E.folderPlan({ proposalId: 'P10281', name: 'Wingstop - St Cloud, FL', city: null, gc: 'CW Hayes: Construction', year: 2026 });
  assert.equal(f.root, 'ByOther/2026/CW Hayes Construction/P10281_Wingstop - St Cloud, FL'); assert.equal(f.folders.length, 6);
  assert.equal(E.cleanName('con'), '_con'); assert.equal(E.cleanName('a/b\\c?'), 'a b c');
});
test('follow-up sequence: first email, call, final email; replies mean interest; award or loss pauses', () => {
  const sub = { id: 's1', date: '2026-10-30' };
  assert.deepEqual(E.followupPlan(null, []), { stage: 'Awaiting Submission', due: null });
  assert.deepEqual(E.followupPlan(sub, []), { stage: 'First Email', due: '2026-11-03' });
  const c1 = [{ kind: 'First Email Sent', date: '2026-11-03', cycle: 's1' }]; assert.deepEqual(E.followupPlan(sub, c1), { stage: 'Call / Message', due: '2026-11-06' });
  const c2 = [...c1, { kind: 'Call / Message', date: '2026-11-06', cycle: 's1' }]; assert.deepEqual(E.followupPlan(sub, c2), { stage: 'Final Email', due: '2026-11-13' });
  assert.equal(E.followupPlan(sub, [...c2, { kind: 'Final Email Sent', date: '2026-11-13', cycle: 's1' }]).stage, 'Sequence Complete');
  assert.equal(E.followupPlan(sub, [...c1, { kind: 'Reply Received', date: '2026-11-04', cycle: 's1' }]).stage, 'Interested');
  assert.equal(E.followupPlan(sub, [], { result: 'Awarded' }).stage, 'Paused'); assert.equal(E.followupPlan(sub, [], { paused: true }).stage, 'Paused');
  assert.equal(E.followupPlan({ id: 's2', date: '2026-12-01' }, c1).stage, 'First Email');   // earlier cycle's emails do not count for a revised submission
});
test('CSV import: quotes, commas, mixed headers and dates', () => {
  const csv = '﻿Project,Company,City,State,Bid Due,Contact Email,Invitation\r\n"Aldi - Orlando, FL (New Shell)",Sun Industrial Inc,Orlando,FL,10/14/2026,brandon@sun.com,https://app.buildingconnected.com/x\r\n"Joy ""Child"" Academy",MEC General Contractors,Apopka,FL,2026-10-15,,\r\n';
  const { rows, missing } = E.mapLeadRows(E.parseCsv(csv)); assert.deepEqual(missing, []); assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].name, rows[0].gc, rows[0].email], ['Aldi - Orlando, FL (New Shell)', 'Sun Industrial Inc', 'brandon@sun.com']); assert.equal(rows[1].name, 'Joy "Child" Academy');
  assert.equal(E.normalizeDate('10/14/2026'), '2026-10-14'); assert.equal(E.normalizeDate('2026-10-15T17:00'), '2026-10-15'); assert.equal(E.normalizeDate('13/45/2026'), null); assert.equal(E.normalizeDate(''), null);
  assert.deepEqual(E.mapLeadRows(E.parseCsv('Foo,Bar\n1,2')).missing, ['name', 'gc']);
  assert.equal(E.leadKey('Sun Industrial, Inc.', 'Aldi - Orlando', '2026-10-14'), E.leadKey('sun industrial inc', 'ALDI Orlando', '2026-10-14'));
});
