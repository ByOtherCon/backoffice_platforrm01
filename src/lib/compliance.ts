// Vendor (subcontractor) compliance: a vendor can be paid only with a W-9 AND valid insurance
// (a COI that has not expired, or a workers' comp exemption that has not expired).
export type Doc = { present: boolean; expires: string | null };
export type VendorDocs = { w9: boolean; coi: Doc; exemption: Doc };
export type Status = 'Valid' | 'Expiring' | 'Expired' | 'Missing';

const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

export function evaluate(d: VendorDocs, today: string, warnDays = 30) {
  const reasons: string[] = [];
  if (!d.w9) reasons.push('No W-9 on file');
  const coiGood = d.coi.present && !!d.coi.expires && d.coi.expires >= today;
  const exGood = d.exemption.present && (!d.exemption.expires || d.exemption.expires >= today);
  if (!d.coi.present && !d.exemption.present) reasons.push('No certificate of insurance or exemption on file');
  else if (!coiGood && !exGood) {
    if (d.coi.present && !d.coi.expires) reasons.push('Certificate of insurance has no expiration date');
    else if (d.coi.present && d.coi.expires! < today) reasons.push(`Certificate of insurance expired ${d.coi.expires}`);
    if (d.exemption.present && d.exemption.expires && d.exemption.expires < today) reasons.push(`Exemption expired ${d.exemption.expires}`);
  }
  const hasInsuranceDoc = d.coi.present || d.exemption.present;
  const canPay = d.w9 && (coiGood || exGood);
  // soonest date coverage lapses (the best valid coverage, so an exemption with no end date means no expiry)
  let nextExpiry: string | null = null;
  if (coiGood || exGood) {
    const ends = [coiGood ? d.coi.expires! : null, exGood ? d.exemption.expires : null];
    nextExpiry = ends.some((e) => e === null && exGood) ? null : (ends.filter(Boolean).sort().at(-1) as string);
  }
  const daysLeft = nextExpiry ? days(today, nextExpiry) : null;
  let status: Status;
  if (!d.w9 || !hasInsuranceDoc) status = 'Missing';
  else if (!canPay) status = 'Expired';
  else status = daysLeft !== null && daysLeft <= warnDays ? 'Expiring' : 'Valid';
  return { status, canPay, reasons, nextExpiry, daysLeft };
}
export const stageFor = (daysLeft: number | null, status: Status): 'd30' | 'd7' | 'expired' | null =>
  status === 'Expired' ? 'expired' : status === 'Expiring' && daysLeft !== null ? (daysLeft <= 7 ? 'd7' : 'd30') : null;

// ---- address verification: the address on the subcontractor's record must be the one their documents show
export type Addr = { street?: string | null; city?: string | null; state?: string | null; zip?: string | null };
const wordsOf = (s: string) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\b(street|st)\b/g, 'st').replace(/\b(avenue|ave)\b/g, 'ave').replace(/\b(road|rd)\b/g, 'rd').replace(/\b(boulevard|blvd)\b/g, 'blvd').replace(/\b(drive|dr)\b/g, 'dr').replace(/\b(suite|ste|unit|apt|bldg|floor|fl|room|rm)\b\s*\w*/g, ' ').replace(/\b(north|n)\b/g, 'n').replace(/\b(south|s)\b/g, 's').replace(/\b(east|e)\b/g, 'e').replace(/\b(west|w)\b/g, 'w').split(/\s+/).filter(Boolean);
// The same place: same street number, the same street name words (suite numbers and St/Street spellings ignored) and the same 5-digit ZIP.
export function sameStreetAddress(a: Addr, b: Addr): boolean {
  const x = wordsOf(a.street || ''), y = wordsOf(b.street || ''); if (!x.length || !y.length) return false;
  const zip = (v?: string | null) => String(v || '').trim().slice(0, 5); if (!zip(a.zip) || zip(a.zip) !== zip(b.zip)) return false;
  const numX = x.find((w) => /^\d+$/.test(w)), numY = y.find((w) => /^\d+$/.test(w)); if (!numX || numX !== numY) return false;
  const name = (ws: string[]) => ws.filter((w) => !/^\d+$/.test(w) && w.length > 1);
  const nx = name(x), ny = name(y); return nx.length > 0 && ny.length > 0 && (nx.every((w) => ny.includes(w)) || ny.every((w) => nx.includes(w)));
}
export const addrKey = (a: Addr) => [wordsOf(a.street || '').join(' '), String(a.city || '').toLowerCase().trim(), String(a.state || '').toUpperCase().trim(), String(a.zip || '').trim().slice(0, 5)].join('|');
export type AddressMatch = 'Matched' | 'Confirmed' | 'Mismatch' | 'Unread' | 'None';
// What still stands between a subcontractor and being paid, beyond the documents themselves.
export function addressChecks(sub: Addr & { verified: boolean; confirmedKey: string | null }, w9Read: Addr | null): { match: AddressMatch; reasons: string[] } {
  const complete = !!(sub.street && sub.city && sub.state && sub.zip);
  if (!complete || !sub.verified) return { match: 'None', reasons: [complete ? 'The address has not been verified' : 'No verified address on file'] };
  if (sub.confirmedKey && sub.confirmedKey === addrKey(sub)) return { match: 'Confirmed', reasons: [] };
  if (!w9Read || !w9Read.street) return { match: 'Unread', reasons: ['The address on the W-9 has not been checked against this one'] };
  return sameStreetAddress(sub, w9Read) ? { match: 'Matched', reasons: [] } : { match: 'Mismatch', reasons: ['The address on the W-9 does not match this address'] };
}
