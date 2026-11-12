// The Estimating workflow as pure rules: statuses, who sees what, auto-decline, address checks, and the follow-up cadence.
import { shift, todayEastern, isWeekend, addBusinessDays, businessDays, weekOf } from './estimating.ts';

export const STATUSES = ['New', 'Reviewing', 'Accepted', 'Started', 'Submitted', 'Declined', 'Decided Not To Submit', 'Awarded', 'Not Awarded', 'No Communication'] as const;
export type Status = (typeof STATUSES)[number];
export const LABEL: Record<string, string> = { 'No Communication': 'No Communication From GC', Awarded: 'Awarded — Create Project in JC' };
export const statusName = (s: string) => (s === 'No Communication' ? 'No Communication From GC' : s);

export const SOURCES = ['Building Connected', 'PlanHub', 'Website', 'In-Person'] as const;
export const PROJECT_TYPES = ['Retail', 'Restaurant', 'Office / Medical / Other'] as const;
export const METHODS = ['Email', 'via BuildingConnected', 'PlanHub', 'Other'] as const;

// Pre-selected reasons, so results can be reported on. Notes stay open text.
export const DECLINE_REASONS = ['Too far / outside our area', 'Wrong trade or scope for us', 'No capacity right now', 'Schedule too tight', 'Project too small', 'Project too large', 'GC not a good fit', 'Duplicate invitation', 'Other (see notes)'];
export const DNTS_REASONS = ["Didn't get to finish", 'Complicated trades', 'GC / plan issues', 'Scope not a fit', 'No capacity', 'Pricing would not be competitive', 'Plans or information missing', 'Project cancelled or on hold', 'Other (see notes)'];
export const EXPIRED_REASON = 'No action taken (lead expired)';
export const NOT_AWARDED_REASONS = ['Price too high', 'GC chose another subcontractor', 'GC did not win the project', 'Scope changed', 'No feedback given', 'Other (see notes)'];

// Where the next move can go. Accepted work never returns to New or Reviewing. Submitting and the three results have their own steps (PDF, project).
const NEXT: Record<string, string[]> = {
  New: ['Reviewing', 'Accepted', 'Declined'],
  Reviewing: ['Accepted', 'Decided Not To Submit'],
  Accepted: ['Started', 'Submitted', 'Decided Not To Submit'],
  Started: ['Accepted', 'Submitted', 'Decided Not To Submit'],
  Submitted: ['Awarded', 'Not Awarded', 'No Communication', 'Started'],
  'Decided Not To Submit': ['Accepted', 'Started'],
  Declined: ['New'],
  Awarded: [],
  'Not Awarded': ['Submitted'],
  'No Communication': ['Awarded', 'Not Awarded', 'Submitted'],
};
export const nextStatuses = (s: string): string[] => NEXT[s] ?? [];
export const canMove = (from: string, to: string) => (NEXT[from] ?? []).includes(to);
export const needsReason = (to: string) => to === 'Declined' || to === 'Decided Not To Submit' || to === 'Not Awarded';
export const reasonsFor = (to: string) => (to === 'Declined' ? DECLINE_REASONS : to === 'Decided Not To Submit' ? DNTS_REASONS : to === 'Not Awarded' ? NOT_AWARDED_REASONS : []);

// Which list a record belongs on.
export const inBids = (s: string) => s === 'New';
export const inProposals = (s: string) => ['Reviewing', 'Accepted', 'Started'].includes(s);
export const inSubmittals = (s: string, hasSubmission: boolean) => ['Accepted', 'Started', 'Submitted'].includes(s) || (hasSubmission && ['Awarded', 'Not Awarded', 'No Communication'].includes(s));
export const PROPOSAL_FILTERS = ['Active', 'Reviewing', 'Accepted', 'Started', 'Submitted', 'Decided Not To Submit', 'All'];

// The old "result" column, kept in step for reports.
export const resultFor = (s: string) => (s === 'Awarded' ? 'Awarded' : s === 'Not Awarded' ? 'Lost' : s === 'Declined' || s === 'Decided Not To Submit' ? 'No Bid' : 'Pending');

// New leads decline N days after their bid date; Reviewing leads M days after; leads with no date never expire.
export type Rules = { declineNewDays: number; declineReviewingDays: number };
export const DEFAULT_RULES: Rules = { declineNewDays: 2, declineReviewingDays: 2 };
export const declineAfterDays = (status: string, rules: Rules = DEFAULT_RULES): number | null => (status === 'New' ? rules.declineNewDays : status === 'Reviewing' ? rules.declineReviewingDays : null);
// A lead someone adds by hand after its bid date has passed is not declined for that date (the keep flag is set only for those leads).
export function autoDeclineDue(status: string, due: string | null, today = todayEastern(), rules: Rules = DEFAULT_RULES, keepPastDue = false): boolean {
  const d = declineAfterDays(status, rules); if (d === null || !due) return false;
  if (keepPastDue) return false;   // note: only set on leads entered by hand

  return today >= shift(due, d);
}

// ---- lists that stay clean on their own
// New opportunities nobody took up: 7 working days after they appeared, or (Tier 3 and 4 only) when the week they arrived in is over.
export const NEW_LEAD_WORKING_DAYS = 7;
export function newLeadExpiry(createdDate: string, tier: number, today = todayEastern()): string | null {
  if (businessDays(createdDate, today) >= NEW_LEAD_WORKING_DAYS) return `No action within ${NEW_LEAD_WORKING_DAYS} working days of the lead arriving (arrived ${createdDate}).`;
  // Tier 3 and 4: until the end of the week they arrived in, but never less than three working days. A lead that comes in on a Thursday, Friday or the weekend
  // gets the following week as well, so it is never declined before anyone has had a chance to look at it.
  if (tier >= 3) { const lastWeek = weekOf(addBusinessDays(createdDate, 2)); if (lastWeek < weekOf(today)) return `Tier ${tier} lead not taken up by the end of its week (arrived ${createdDate}, that week ended ${shift(lastWeek, 6)}).`; }
  return null;
}
// Accepted or Started work with no submission: a red "expiring" note 3 days after the bid due date, and Decided Not To Submit 2 days later.
export function workExpiry(status: string, due: string | null, submitted: boolean, today = todayEastern()): 'expiring' | 'expired' | null {
  if (!due || submitted || !['Accepted', 'Started'].includes(status)) return null;
  return today >= shift(due, 5) ? 'expired' : today >= shift(due, 3) ? 'expiring' : null;
}
// Row colour: green when submitted, yellow when started with time left, red on or after the due date without a submission.
export function rowTone(status: string, due: string | null, submitted: boolean, today = todayEastern()): 'green' | 'yellow' | 'red' | '' {
  if (submitted || ['Submitted', 'Awarded', 'Not Awarded', 'No Communication'].includes(status)) return 'green';
  if (['Accepted', 'Started'].includes(status)) { if (due && due <= today) return 'red'; return status === 'Started' ? 'yellow' : ''; }
  return '';
}

// ---- addresses (Florida only for the project; the GC may be anywhere)
// "8001 South Orange Blossom Trail, Suite 606, Orlando, FL 32809" -> street, city, state, zip (the ZIP may be missing).
export function splitAddress(full: string | null | undefined) {
  const m = String(full ?? '').trim().match(/^(.+),\s*([^,]+),\s*([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\.?$/); if (!m) return null;
  return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] || '' };
}
export type Addr = { street?: string | null; city?: string | null; state?: string | null; zip?: string | null };
export const cleanAddr = (a: Addr) => ({ street: String(a.street ?? '').replace(/\s+/g, ' ').trim(), city: String(a.city ?? '').replace(/\s+/g, ' ').trim(), state: String(a.state ?? '').trim().toUpperCase(), zip: String(a.zip ?? '').trim() });
export const addrEmpty = (a: Addr) => { const c = cleanAddr(a); return !c.street && !c.city && !c.zip; };
export function checkAddr(a: Addr, { florida = false, label = 'Address' } = {}): string[] {
  const c = cleanAddr(a), e: string[] = [];
  if (c.street.length < 3 || !/\d/.test(c.street)) e.push(`${label}: enter the street with its number (for example 123 Main St).`);
  if (!/^[A-Za-z][A-Za-z .'-]{1,59}$/.test(c.city)) e.push(`${label}: enter the city.`);
  if (!/^[A-Z]{2}$/.test(c.state)) e.push(`${label}: enter the two-letter state.`);
  else if (florida && c.state !== 'FL') e.push(`${label}: this system is for Florida projects only.`);
  if (!/^\d{5}(-\d{4})?$/.test(c.zip)) e.push(`${label}: enter a 5-digit ZIP code.`);
  else if (florida && !(Number(c.zip.slice(0, 5)) >= 32003 && Number(c.zip.slice(0, 5)) <= 34997)) e.push(`${label}: that ZIP code is not in Florida.`);
  return e;
}
export const addrLine = (a: Addr) => { const c = cleanAddr(a); return [c.street, c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '); };
export const sameAddr = (a: Addr, b: Addr) => { const x = cleanAddr(a), y = cleanAddr(b); return x.street.toLowerCase() === y.street.toLowerCase() && x.city.toLowerCase() === y.city.toLowerCase() && x.state === y.state && x.zip.slice(0, 5) === y.zip.slice(0, 5); };

// ---- business days (Monday to Friday, Eastern, no holiday calendar)
export function subBusinessDays(s: string, n: number): string { let d = s; while (n > 0) { d = shift(d, -1); if (!isWeekend(d)) n--; } return d; }
const nextBusinessDay = (s: string) => (isWeekend(s) ? addBusinessDays(s, 1) : s);

// ---- follow-up cadence: email at 7 business days, call 3 after the email, second call at least 2 after the first, final email 4 after the second call, close 2 after.
export const STANDARD = { first: 7, call1: 3, callGap: 2, final: 4, close: 2 };
export type Log = { kind: string; date: string };
export type Step = { key: 'email1' | 'call1' | 'call2' | 'final' | 'close'; label: string; kind: 'email' | 'call' | 'status'; due: string | null; done: string | null };

// Waits for the steps still to do, shortened only as far as the project start date requires:
// first the opening wait (down to 1), then the final-email wait (down to 1), then the first-call wait (down to 1). The gap between calls stays at 2.
export function fitWaits(fromIdx: number, anchor: string, cutoff: string | null) {
  const w = { first: STANDARD.first, call1: STANDARD.call1, final: STANDARD.final };
  if (!cutoff) return { ...w, fits: true };
  const need = () => (fromIdx <= 0 ? w.first : 0) + (fromIdx <= 1 ? w.call1 : 0) + (fromIdx <= 2 ? STANDARD.callGap : 0) + (fromIdx <= 3 ? w.final : 0);
  const room = businessDays(anchor, cutoff);
  for (const [k, min, from] of [['first', 1, 0], ['final', 1, 3], ['call1', 1, 1]] as const) {
    if (fromIdx > from) continue;
    while (need() > room && w[k] > min) w[k]--;
  }
  return { ...w, fits: need() <= room };
}
export function followupPlan(submitted: string, log: Log[], opts: { startDate?: string | null; today?: string } = {}) {
  const today = opts.today ?? todayEastern(), cutoff = opts.startDate ? subBusinessDays(opts.startDate, 4) : null;
  const mine = log.filter((l) => l.date >= submitted).sort((a, b) => a.date.localeCompare(b.date));
  const first = (k: string) => mine.find((l) => l.kind === k)?.date ?? null;
  const e1 = first('First Email Sent'), c1 = e1 ? mine.find((l) => l.kind === 'Call 1' && l.date >= e1)?.date ?? null : null;
  const c2 = c1 ? mine.find((l) => l.kind === 'Call 2' && l.date >= c1)?.date ?? null : null, ef = c2 ? mine.find((l) => l.kind === 'Final Email Sent' && l.date >= c2)?.date ?? null : null;
  const done = [e1, c1, c2, ef], idx = done.findIndex((d) => !d);
  const anchors = [submitted, e1, c1, c2];
  const steps: Step[] = [
    { key: 'email1', label: 'First email', kind: 'email', due: null, done: e1 }, { key: 'call1', label: 'Call 1', kind: 'call', due: null, done: c1 },
    { key: 'call2', label: 'Call 2', kind: 'call', due: null, done: c2 }, { key: 'final', label: 'Final email', kind: 'email', due: null, done: ef },
    { key: 'close', label: 'Close as No Response', kind: 'status', due: null, done: null }];
  let needsReview = false, dueNow: string | null = null;
  if (idx >= 0) {
    // Project forward from the real dates. A step that is overdue is not backdated: the steps after it count from today.
    let anchor = anchors[idx] as string;
    for (let i = idx; i < 4; i++) {
      const f = fitWaits(i, anchor, cutoff), wait = i === 0 ? f.first : i === 1 ? f.call1 : i === 2 ? STANDARD.callGap : f.final;
      const due = nextBusinessDay(addBusinessDays(anchor, wait)); steps[i].due = due;
      if (i === idx) dueNow = due;
      if (!f.fits) needsReview = true;
      anchor = due > today ? due : today;
    }
    const last = steps[3].due as string; steps[4].due = addBusinessDays(last, STANDARD.close);
    if (cutoff && last > cutoff) needsReview = true;
  } else { steps[4].due = addBusinessDays(ef as string, STANDARD.close); dueNow = steps[4].due; }
  const stage = idx >= 0 ? steps[idx].label : 'Close as No Response';
  return { steps, stage, due: dueNow, cutoff, needsReview, overdue: !!dueNow && dueNow < today, closeDue: idx < 0 && !!dueNow && today >= dueNow, complete: idx < 0 };
}

// ---- follow-up messages. Missing facts are reported, never invented.
export type Ctx = { project: string; address: string; proposalId: string; submittedDate: string; trades: string; gcContact: string; estimator: string; estimatorPhone: string; caller?: string; callerPhone?: string };
const fmt = (d: string) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
export function followupDrafts(c: Ctx) {
  const first = c.gcContact.trim().split(/\s+/)[0] || '', sig = `${c.estimator}\nEstimating | byOther Construction\n${c.estimatorPhone}\nestimates@byother.net`;
  const missing = Object.entries({ 'GC contact name': c.gcContact, 'project address': c.address, 'submitted trades': c.trades, 'estimator name': c.estimator, 'estimator phone': c.estimatorPhone }).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  const subj = `Proposal follow-up | ${c.project} | ${c.proposalId}`;
  return { missing,
    email1: { subject: subj, body: `Hi ${first},\n\nI wanted to check on the proposal we submitted on ${fmt(c.submittedDate)} for ${c.project} at ${c.address}, covering ${c.trades}.\n\nHas the project or this scope been awarded, and is byOther still being considered? Please let us know if you need anything clarified or would like to discuss our scope or pricing.\n\nThank you,\n${sig}` },
    final: { subject: 'Re: ' + subj, body: `Hi ${first},\n\nI'm checking once more on our proposal for ${c.project} at ${c.address}, submitted on ${fmt(c.submittedDate)} for ${c.trades}.\n\nHave the contracts for this scope been awarded, and is byOther still being considered? We would also appreciate any feedback on our scope, pricing, or anything we could improve in the proposal.\n\nIf the award is still pending, a quick update on timing would be helpful. If another subcontractor was selected for our scope, please let us know so we can update our records.\n\nThank you,\n${sig}` },
    call: `Hi ${c.gcContact}, this is ${c.caller || '[your name]'} with byOther Construction. I'm following up on our proposal for ${c.project} at ${c.address}. ${c.estimator} is the estimator, and our submitted scope included ${c.trades}.\n\nHas the project or our scope been awarded? Is byOther still being considered? Is there anything you need from us, and do you have any feedback on our proposal? If the award is pending, when would be a good time for us to check back?`,
    voicemail: `Hi ${first}, this is ${c.caller || '[your name]'} with byOther Construction, following up on our proposal for ${c.project} at ${c.address} for ${c.trades}. Please call me at ${c.callerPhone || '[your phone]'} or reply to estimates@byother.net with an update on the award and whether we're still being considered. Again, this is ${c.caller || '[your name]'} at ${c.callerPhone || '[your phone]'}. Thank you.`,
    replyPending: `Thanks for the update, ${first}. We'll keep ${c.project} open as awaiting the GC's award. ${c.estimator} is available if you need anything on ${c.trades}. When would you like us to check back?`,
    replyNotSelected: `Thank you for letting us know, ${first}. We appreciate the opportunity to bid ${c.project}. If you're able to share any feedback on our scope or pricing for ${c.trades}, we'd value it and would welcome consideration on future projects.` };
}
