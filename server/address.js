// Address checking for the opportunity form. The street/city/state/ZIP are checked for shape, then matched against the
// U.S. Census geocoder (free, no key). A match returns the standardized address and a signed token; saving a record
// with an address needs that token, so a green check cannot be faked by editing the request.
import crypto from 'node:crypto';
import { bad, HttpError } from './http.js';
import { cleanAddr, checkAddr, addrLine, splitAddress, addrEmpty, sameAddr } from '../src/lib/workflow.ts';

let afetch = (...a) => fetch(...a);
export const setAddressFetch = (f) => { afetch = f; };   // tests stand in for the Census service
const fallbackKey = crypto.randomBytes(32).toString('hex');
const key = () => process.env.SECRET_KEY || fallbackKey;
const canon = (a) => { const c = cleanAddr(a); return [c.street.toLowerCase(), c.city.toLowerCase(), c.state, c.zip.slice(0, 5)].join('|'); };
const sign = (a, method) => crypto.createHmac('sha256', key()).update(canon(a) + '|' + method).digest('base64url');
export const tokenFor = (a, method) => `${method}.${sign(a, method)}`;
export function tokenValid(a, token) {
  const [method, sig] = String(token || '').split('.'); if (!['census', 'format'].includes(method) || !sig) return false;
  const want = Buffer.from(sign(a, method)), got = Buffer.from(sig); return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Street text the geocoder can match: unit / suite / space numbers are taken out (the person's own wording is what gets saved).
const forGeocoder = (street) => street.replace(/,?\s*\b(suite|ste|unit|apt|apartment|bldg|building|space|spc|room|rm|floor|fl)\b\.?\s*#?\s*[\w-]+/gi, '').replace(/,?\s*#\s*[\w-]+/g, '').replace(/\s+/g, ' ').trim();
export async function verifyAddress(b, { florida = false, label = 'Address' } = {}) {
  let a = cleanAddr(b || {});
  const sp = splitAddress(a.street); if (sp) a = cleanAddr({ street: sp.street, city: sp.city || a.city, state: sp.state || a.state, zip: sp.zip || a.zip });   // a whole address typed into the street box is split up
  if (!a.state) a.state = florida ? 'FL' : '';
  const errors = checkAddr(a, { florida, label }).filter((e) => !(!a.zip && /ZIP/.test(e)));                                  // a missing ZIP is looked up below
  if (errors.length) return { verified: false, errors };
  try {
    const q = { street: forGeocoder(a.street), city: a.city, state: a.state, benchmark: 'Public_AR_Current', format: 'json' }; if (a.zip) q.zip = a.zip.slice(0, 5);
    const r = await afetch('https://geocoding.geo.census.gov/geocoder/addresses?' + new URLSearchParams(q), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json(); const m = j?.result?.addressMatches?.[0];
    if (!m) return { verified: false, noMatch: true, errors: [`${label}: that address was not found. Check the street number, city and ZIP, or use it as entered.`], address: a, line: addrLine(a), token: a.zip ? tokenFor(a, 'format') : null };
    const c = m.addressComponents || {}, title = (x) => String(x || '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    // keep the street as typed; take city, state and ZIP from the matched record
    const out = cleanAddr({ street: a.street, city: c.city ? title(c.city) : a.city, state: c.state || a.state, zip: c.zip || a.zip });
    const again = checkAddr(out, { florida, label }); if (again.length) return { verified: false, errors: again };
    return { verified: true, method: 'census', address: out, line: addrLine(out), token: tokenFor(out, 'census') };
  } catch {
    // The matching service cannot be reached. The address was checked field by field, so it is accepted on that basis (marked "format").
    if (!a.zip) return { verified: false, errors: [`${label}: enter the 5-digit ZIP code. The address service could not be reached to look it up.`] };
    return { verified: true, method: 'format', address: a, line: addrLine(a), token: tokenFor(a, 'format') };
  }
}
export function requireVerified(b, token, { florida = false, label = 'Address' } = {}) {
  const a = cleanAddr(b || {}); const errors = checkAddr(a, { florida, label }); if (errors.length) throw bad(errors[0]);
  if (!tokenValid(a, token)) throw new HttpError(400, `${label}: press Verify so it gets its green check before saving.`);
  return a;
}

// What a form sends for a stored address: { street, city, state, zip, token }. Returns the database columns for it.
// An unchanged address that was already checked is kept as it is; anything else needs the green check (the token).
// A trusted caller that already holds a checked address (an accepted opportunity) passes the option trusted: true (never read from the request).
// `old` is the stored row (address, city, state, zip, address_verified). An empty address clears the columns unless it is required.
export function addressColumns(a, { florida = false, label = 'Address', required = false, old = null, trusted = false } = {}) {
  if (!a || addrEmpty(a)) { if (required) throw bad(`${label} is required. Enter it and press Verify.`); return { address: null, city: null, state: null, zip: null, address_verified: false }; }
  const c = cleanAddr({ ...a, state: a.state || (florida ? 'FL' : '') });
  const cur = old ? { street: old.address, city: old.city, state: old.state, zip: old.zip } : null;
  if (trusted) { const errors = checkAddr(c, { florida, label }); if (errors.length) throw bad(errors[0]); }
  else if (!(old?.address_verified && cur && sameAddr(c, cur))) requireVerified(c, a.token, { florida, label });
  return { address: c.street, city: c.city, state: c.state, zip: c.zip, address_verified: true };
}
// Old callers send one line ("123 Main St, Orlando, FL 32801"). It is split when it can be, and kept unchecked.
export function legacyAddressColumns(line) {
  const s = String(line ?? '').trim(); if (!s) return { address: null, city: null, state: null, zip: null, address_verified: false };
  const sp = splitAddress(s); return sp ? { address: sp.street, city: sp.city, state: sp.state, zip: sp.zip || null, address_verified: false } : { address: s, city: null, state: null, zip: null, address_verified: false };
}
