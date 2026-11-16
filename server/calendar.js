// Bid due dates on a person's own calendar (Outlook, Google Calendar, Apple Calendar).
// Each person has a private link to a calendar feed. Their calendar app subscribes to it once and then re-reads it on its own schedule
// (Outlook every few hours, Google Calendar about once a day), so the bids move by themselves when a date changes here.
// The link carries a long random key instead of a sign-in, because calendar apps cannot sign in; Reset makes a new key and the old link stops working.
import crypto from 'node:crypto';
import { q } from './db.js';
import { HttpError } from './http.js';
import { baseUrl } from './bids.js';
import * as W from '../src/lib/workflow.ts';
import { todayEastern, shift } from '../src/lib/estimating.ts';

const OPEN = ['New', 'Reviewing', 'Accepted', 'Started'];   // not yet submitted: these are the dates that can still be missed
const newKey = () => crypto.randomBytes(24).toString('base64url');
const links = (key) => { const url = `${baseUrl()}/api/calendar/bids.ics?key=${key}`; return { all: url, mine: url + '&mine=1' }; };

export async function linkFor(user) {
  let [r] = await q('SELECT calendar_token FROM app_users WHERE id=$1', [user.id]); if (!r) throw new HttpError(404, 'User not found.');
  if (!r.calendar_token) { r = { calendar_token: newKey() }; await q('UPDATE app_users SET calendar_token=$2 WHERE id=$1', [user.id, r.calendar_token]); }
  return links(r.calendar_token);
}
export async function resetLink(user) { const key = newKey(); await q('UPDATE app_users SET calendar_token=$2 WHERE id=$1', [user.id, key]); return links(key); }

// ---- writing the calendar file (iCalendar, RFC 5545)
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// a line is at most 75 bytes; a longer one continues on the next line after a space
const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
const ymd = (d) => String(d).slice(0, 10).replace(/-/g, '');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const EASTERN = ['BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'];

export async function feed(key, { mine = false } = {}) {
  const [user] = key ? await q('SELECT id, name FROM app_users WHERE calendar_token=$1 AND active', [String(key)]) : []; if (!user) throw new HttpError(404, 'This calendar link is no longer valid. Get the new one from the Estimating page.');
  const today = todayEastern(), site = baseUrl();
  const rows = await q(`SELECT o.id, o.name, o.gc_name, o.status, o.due_date::text AS due, o.due_time, o.proposal_id, o.address, o.city, o.zip, o.contact_name, o.contact_phone, o.contact_email, o.created_at, u.name AS estimator
    FROM opportunities o LEFT JOIN app_users u ON u.id=o.estimator_id
    WHERE o.merged_into IS NULL AND o.status = ANY($1::text[]) AND o.due_date IS NOT NULL AND o.due_date >= $2 ${mine ? 'AND o.estimator_id = $3' : ''} ORDER BY o.due_date, o.name`, mine ? [OPEN, shift(today, -14), user.id] : [OPEN, shift(today, -14)]);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//by Other Construction//Desk Platform//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(mine ? 'byOther bids (mine)' : 'byOther bids')}`, 'X-WR-TIMEZONE:America/New_York', 'REFRESH-INTERVAL;VALUE=DURATION:PT2H', 'X-PUBLISHED-TTL:PT2H', ...EASTERN];
  for (const o of rows) {
    const where = [o.address, o.city, o.zip ? `FL ${o.zip}` : o.city ? 'FL' : ''].filter(Boolean).join(', ');
    const about = [`Status: ${W.statusName(o.status)}`, o.proposal_id ? `Proposal: ${o.proposal_id}` : null, `GC: ${o.gc_name}`, o.contact_name ? `Contact: ${[o.contact_name, o.contact_phone, o.contact_email].filter(Boolean).join(', ')}` : null, o.estimator ? `Estimator: ${o.estimator}` : 'No estimator yet', `Open it: ${site}/#/estimating/${o.id}`].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:bid-${o.id}@byother-desk`, `DTSTAMP:${stamp(new Date())}`);
    if (/^\d\d:\d\d/.test(o.due_time || '')) { const [hh, mm] = o.due_time.split(':').map(Number), end = hh * 60 + mm + 30, eh = Math.min(23, Math.floor(end / 60)), em = end >= 24 * 60 ? 59 : end % 60, p = (n) => String(n).padStart(2, '0');
      lines.push(`DTSTART;TZID=America/New_York:${ymd(o.due)}T${p(hh)}${p(mm)}00`, `DTEND;TZID=America/New_York:${ymd(o.due)}T${p(eh)}${p(em)}00`); }
    else lines.push(`DTSTART;VALUE=DATE:${ymd(o.due)}`, `DTEND;VALUE=DATE:${ymd(shift(o.due, 1))}`);
    lines.push(`SUMMARY:${esc(`Bid due: ${o.name} (${o.gc_name})`)}`, `DESCRIPTION:${esc(about)}`, ...(where ? [`LOCATION:${esc(where)}`] : []), `URL:${site}/#/estimating/${o.id}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
