// Address checking for the opportunity form. The street/city/state/ZIP are checked for shape, then matched against the
// U.S. Census geocoder (free, no key). A match returns the standardized address and a signed token; saving a record
// with an address needs that token, so a green check cannot be faked by editing the request.
import crypto from 'node:crypto';
import { bad, HttpError } from './http.js';
import { cleanAddr, checkAddr, addrLine } from '../src/lib/workflow.ts';

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

export async function verifyAddress(b, { florida = false, label = 'Address' } = {}) {
  const a = cleanAddr(b || {}); if (!a.state) a.state = florida ? 'FL' : '';
  const errors = checkAddr(a, { florida, label }); if (errors.length) return { verified: false, errors };
  try {
    const url = 'https://geocoding.geo.census.gov/geocoder/addresses?' + new URLSearchParams({ street: a.street, city: a.city, state: a.state, zip: a.zip.slice(0, 5), benchmark: 'Public_AR_Current', format: 'json' });
    const r = await afetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('status ' + r.status);
    const j = await r.json(); const m = j?.result?.addressMatches?.[0];
    if (!m) return { verified: false, errors: [`${label}: that address was not found. Check the street number, city and ZIP.`] };
    const c = m.addressComponents || {}, title = (x) => String(x || '').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    // keep the street as typed (it is the person's wording); take city, state and ZIP from the matched record
    const out = cleanAddr({ street: a.street, city: c.city ? title(c.city) : a.city, state: c.state || a.state, zip: c.zip || a.zip });
    const again = checkAddr(out, { florida, label }); if (again.length) return { verified: false, errors: again };
    return { verified: true, method: 'census', address: out, line: addrLine(out), token: tokenFor(out, 'census') };
  } catch {
    // The matching service is unreachable. The shape was already checked, so the person may accept it as entered.
    return { verified: false, serviceDown: true, errors: [], message: 'The address service could not be reached. The address looks well formed; you can use it as entered.', token: tokenFor(a, 'format'), address: a, line: addrLine(a) };
  }
}
export function requireVerified(b, token, { florida = false, label = 'Address' } = {}) {
  const a = cleanAddr(b || {}); const errors = checkAddr(a, { florida, label }); if (errors.length) throw bad(errors[0]);
  if (!tokenValid(a, token)) throw new HttpError(400, `${label}: press Verify so it gets its green check before saving.`);
  return a;
}
