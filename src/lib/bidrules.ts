// Bid inbox helpers: search window, ranking, regions, and recognising the same job. Status and decline rules live in workflow.ts.

// Search covers every lead seen in the last 30 days, declined ones included. Older leads must be added by hand.
export const SEARCH_DAYS = 30;
export const withinSearchWindow = (lastSeen: Date | string, now = new Date()): boolean => now.getTime() - new Date(lastSeen).getTime() <= SEARCH_DAYS * 86400000;

// Ranking inside a week: region tier, then shopping-center jobs, then project type.
export const TYPE_ORDER = ['Retail', 'Restaurant', 'Office / Medical / Other', 'Other'];
export const rankLeads = <T extends { tier: number; mall: boolean; type: string; name: string; gc: string }>(a: T, b: T) =>
  a.tier - b.tier || Number(b.mall) - Number(a.mall) || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name) || a.gc.localeCompare(b.gc);
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// A city as people type it ("Orlando, FL", "Orlando FL 32801", "St. Cloud") reduced to the name the city list uses.
const stripPlace = (c: string) => String(c || '').replace(/\b\d{5}(-\d{4})?\b/g, ' ').replace(/,?\s*\b(fl|fla|florida)\b\.?/gi, ' ').replace(/\bsaint\b/gi, 'st').replace(/\bst\.\s/gi, 'st ').replace(/\bft\.?\s/gi, 'fort ').replace(/\bmt\.?\s/gi, 'mount ');
export const cityKey = (c: string | null) => norm(stripPlace(c || ''));
// The tier and why. A city that is not typed exactly as listed still counts; a missing or unlisted city is looked for in the address and the project name
// before falling back to Tier 3, and the note says which it was so a wrong tier can be traced.
export function tierWhy(city: string | null, map: Record<string, number>, ...context: (string | null | undefined)[]): { tier: number; note: string } {
  const raw = String(city || '').trim(), key = cityKey(raw);
  if (key && map[key] != null) return { tier: map[key], note: `${raw}: Tier ${map[key]}` };
  const hay = norm(stripPlace(context.filter(Boolean).join(' '))); let best = '';
  for (const k of Object.keys(map)) if (k.length >= 5 && hay.includes(k) && k.length > best.length) best = k;
  if (best) return { tier: map[best], note: `${raw ? `"${raw}" is not on the city list; ` : 'No city was entered; '}found ${best} in the address or project name: Tier ${map[best]}` };
  return { tier: 3, note: raw ? `"${raw}" is not on the city list, so it defaults to Tier 3. Correct the city or add it in Admin.` : 'No city was entered, so it defaults to Tier 3. Enter the city.' };
}
export const tierFor = (city: string | null, map: Record<string, number>, ...context: (string | null | undefined)[]): number => tierWhy(city, map, ...context).tier;
export const looksLikeShoppingCenter = (...parts: (string | null | undefined)[]) => /\b(outlets?|mall|shoppes|shops at|town center|plaza|marketplace|promenade|village|commons|crossing|center)\b/i.test(parts.filter(Boolean).join(' '));

// ---- recognising the same job invited by more than one GC
export const gcKey = (s: string) => norm(String(s || '').replace(/\b(construction|contractors|contracting|company|group|llc|inc|incorporated|corp|corporation)\b/gi, '')) || norm(s);
// Every GC a job was pitched to: the lead's own GC first, then the others on its invitation list (each once).
export function gcNames(gcName: string | null, invitations: Array<{ gc?: string }> | null | undefined): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const g of [gcName, ...(Array.isArray(invitations) ? invitations.map((i) => i.gc) : [])]) { const k = gcKey(String(g || '')); if (!g || !k || seen.has(k)) continue; seen.add(k); out.push(String(g)); }
  return out;
}
const STOP = ['fl', 'florida', 'orlando', 'at', 'the', 'and', 'expansion', 'remodel', 'renovation', 'marketplace', 'outlet', 'new', 'construction', 'project'];
const words = (s: string) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.includes(w));
const GENERIC_PLACE = ['mall', 'plaza', 'center', 'centre', 'shops', 'shoppes', 'shopping', 'outlets', 'outlet', 'premium', 'town', 'square', 'village', 'the', 'at', 'of', 'and'];
// The street is the part that starts with a house number. A place name in front of it ("The Plaza at Citrus Park, 12851 Citrus Plaza Drive")
// or instead of it ("Mall at Millenia, Orlando") is not a street, so it never makes one job look like two addresses.
function addressParts(value: string | null) {
  const low = String(value || '').toLowerCase(), parts = low.split(',').map((s) => s.trim()), si = parts.findIndex((p) => /^\d+[a-z]?\s+\S/.test(p));
  const tag = low.match(/(?:#\s*|\b(?:suite|ste|unit|apt)\.?\s*)([a-z0-9-]+)/i), space = low.match(/\b(?:space|spc)\.?\s*#?\s*([a-z]?-?\d[a-z0-9-]*)/i), next = si >= 0 ? parts[si + 1] || '' : '';
  const unit = space?.[1] || tag?.[1] || (/^[a-z]?\d+[a-z]?$/.test(next) ? next : '');
  let street = (si >= 0 ? parts[si] : '').replace(/\b(?:space|spc)\.?\s*#?\s*[a-z]?-?\d[a-z0-9-]*/gi, '').replace(/(?:#|\b(?:suite|ste|unit|apt)\.?\s+)[a-z0-9-]+/gi, '');
  for (const [s, l] of [['dr', 'drive'], ['rd', 'road'], ['st', 'street'], ['ave', 'avenue'], ['blvd', 'boulevard'], ['ln', 'lane'], ['pkwy', 'parkway'], ['hwy', 'highway'], ['trl', 'trail'], ['ct', 'court'], ['n', 'north'], ['s', 'south'], ['e', 'east'], ['w', 'west']]) street = street.replace(new RegExp('\\b' + s + '\\b', 'g'), l);
  return { street: norm(street), unit: norm(unit), place: si === 0 ? [] : (parts[0] || '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !GENERIC_PLACE.includes(w)) };   // place: "mall at millenia", when the address starts with a name
}
// The words of a project name that say WHICH job it is (the store, the brand), not WHERE it is. Left out: the place ("Mall at Millenia",
// "Millenia Mall", "Plaza at Citrus Park", "Lutz Premium Outlets": a place word, the word just before it, and everything after "at"),
// the city, the GC's own codes ("OPP-138227", "RM3543") and filler. Two stores at the same mall share every place word, so only these words
// can tell them apart.
const ANCHOR = ['mall', 'plaza', 'center', 'centre', 'shops', 'shoppes', 'shopping', 'outlets', 'outlet', 'premium', 'square', 'village', 'commons', 'galleria', 'promenade'];
const FILLER = ['opp', 'rm', 'bid', 'invite', 'invitation', 'rfp', 'tenant', 'improvement', 'ti', 'store', 'space', 'suite', 'unit'];
// The same brand written differently: "A&F Kids" and "Abercrombie & Fitch" are Abercrombie & Fitch.
const BRANDS: [RegExp, string, string][] = [[/\ba\s*&\s*f\b|\ba\s+and\s+f\b/g, 'abercrombie', 'Abercrombie & Fitch'], [/\babercrombie(\s*(&|and)\s*fitch)?\b/g, 'abercrombie', 'Abercrombie & Fitch']];
const brandWords = (s: string) => BRANDS.reduce((x, [re, w]) => x.replace(re, w), String(s || '').toLowerCase());
export function tenantWords(name: string, ...cities: (string | null | undefined)[]): string[] {
  const cityW = new Set(cities.flatMap((c) => String(c || '').toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean)), out = new Set<string>();
  for (const seg of brandWords(name).split(/[-\u2013\u2014_,()|/:;]+/)) {
    const t = seg.split(/[^a-z0-9]+/).filter(Boolean), place = new Set<number>(), at = t.indexOf('at');
    if (at >= 0) for (let i = at; i < t.length; i++) place.add(i);
    t.forEach((w, i) => { if (ANCHOR.includes(w)) { place.add(i); if (i > 0 && !ANCHOR.includes(t[i - 1])) place.add(i - 1); } });
    t.forEach((w, i) => { if (!place.has(i) && w.length > 1 && !/\d/.test(w) && !STOP.includes(w) && !FILLER.includes(w) && !GENERIC_PLACE.includes(w) && !cityW.has(w)) out.add(w); });
  }
  return [...out];
}
// The client a project name points to: the brand when it is a known one written several ways, else the first part of the name that says
// which store it is ("Old Navy 5904 Refresh - Tampa" gives "Old Navy 5904 Refresh"). Empty when the name only says where (a GC code and a mall).
export function clientFromName(name: string, ...cities: (string | null | undefined)[]): string {
  const low = String(name || '').toLowerCase(); for (const [re, , label] of BRANDS) { re.lastIndex = 0; if (re.test(low)) { re.lastIndex = 0; return label; } }
  for (const seg of String(name || '').split(/\s+[-\u2013\u2014]\s+|_|,/)) if (tenantWords(seg, ...cities).length) return seg.trim().replace(/\s+/g, ' ').slice(0, 120);
  return '';
}
// The street of an address in one form ("4200 Conroy Rd, Space #C-196" and "4200 Conroy Road" give the same), empty when there is no house number.
export const streetKey = (address: string | null) => addressParts(address).street;
// "#C-196" and "#196" are the same space; "983" and "120" are not.
const unitNo = (u: string) => u.replace(/[^0-9]/g, '');
const sameUnit = (a: string, b: string) => a === b || (!!unitNo(a) && unitNo(a) === unitNo(b) && (a === unitNo(a) || b === unitNo(b)));
export function sameJob(a: { name: string; city: string | null; address: string | null; threadId?: string | null }, b: typeof a): boolean {
  if (a.threadId && a.threadId === b.threadId) return true;
  const ca = cityKey(a.city), cb = cityKey(b.city);
  if (ca && cb && ca !== cb) return false;   // "Orlando" and "Orlando, FL" are the same city
  // one of them has no city on file: its address or name has to mention the other one's city
  if (!ca !== !cb) { const known = ca || cb, blank = ca ? b : a; if (!norm(`${blank.address || ''} ${blank.name || ''}`).includes(known)) return false; }
  const aa = addressParts(a.address), ba = addressParts(b.address); if (aa.unit && ba.unit && !sameUnit(aa.unit, ba.unit)) return false;
  if (aa.street && ba.street && aa.street !== ba.street) return false;
  if (!aa.street && !ba.street && aa.place.length && ba.place.length && !aa.place.some((w) => ba.place.includes(w))) return false;   // two different malls, no street on either   // two different addresses are two jobs, whatever they are called
  if (norm(a.name) === norm(b.name)) return true;
  const wa = words(a.name), wb = words(b.name), common = wa.filter((t) => wb.includes(t)).length;
  // the names have to share a word that says which job it is: at one street (a mall, a plaza) every store shares the place and the city
  const ta = tenantWords(a.name, a.city, b.city), tb = tenantWords(b.name, a.city, b.city), which = ta.filter((t) => tb.includes(t)).length;
  if (aa.street && aa.street === ba.street) return which >= 1;
  // no address to compare (one or both missing): the project names have to say the same thing, every meaningful word of the shorter one
  return which >= 1 && common >= 1 && common === Math.min(wa.length, wb.length);
}
