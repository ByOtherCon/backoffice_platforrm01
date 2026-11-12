// Bid inbox helpers: search window, ranking, regions, and recognising the same job. Status and decline rules live in workflow.ts.

// Search covers every lead seen in the last 30 days, declined ones included. Older leads must be added by hand.
export const SEARCH_DAYS = 30;
export const withinSearchWindow = (lastSeen: Date | string, now = new Date()): boolean => now.getTime() - new Date(lastSeen).getTime() <= SEARCH_DAYS * 86400000;

// Ranking inside a week: region tier, then shopping-center jobs, then project type.
export const TYPE_ORDER = ['Retail', 'Restaurant', 'Office / Medical / Other'];
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
const STOP = ['fl', 'florida', 'orlando', 'at', 'the', 'and', 'expansion', 'remodel', 'renovation', 'marketplace', 'outlet', 'new', 'construction', 'project'];
const words = (s: string) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.includes(w));
function addressParts(value: string | null) {
  const parts = String(value || '').toLowerCase().split(',').map((s) => s.trim()), tag = String(value || '').toLowerCase().match(/(?:#\s*|\b(?:suite|ste|unit|apt)\.?\s*)([a-z0-9-]+)/i);
  const unit = tag?.[1] || (/^[a-z]?\d+[a-z]?$/.test(parts[1] || '') ? parts[1] : ''); let street = (parts[0] || '').replace(/(?:#|\b(?:suite|ste|unit|apt)\.?\s+)[a-z0-9-]+/gi, '');
  for (const [s, l] of [['dr', 'drive'], ['rd', 'road'], ['st', 'street'], ['ave', 'avenue'], ['blvd', 'boulevard'], ['ln', 'lane'], ['pkwy', 'parkway'], ['hwy', 'highway'], ['trl', 'trail'], ['ct', 'court'], ['n', 'north'], ['s', 'south'], ['e', 'east'], ['w', 'west']]) street = street.replace(new RegExp('\\b' + s + '\\b', 'g'), l);
  return { street: norm(street), unit: norm(unit) };
}
export function sameJob(a: { name: string; city: string | null; address: string | null; threadId?: string | null }, b: typeof a): boolean {
  if (a.threadId && a.threadId === b.threadId) return true;
  if (cityKey(a.city) !== cityKey(b.city)) return false;   // "Orlando" and "Orlando, FL" are the same city
  const aa = addressParts(a.address), ba = addressParts(b.address); if (aa.unit && ba.unit && aa.unit !== ba.unit) return false;
  if (aa.street && ba.street && aa.street !== ba.street) return false;   // two different addresses are two jobs, whatever they are called
  if (norm(a.name) === norm(b.name)) return true;
  const wa = words(a.name), wb = words(b.name), common = wa.filter((t) => wb.includes(t)).length;
  if (aa.street && aa.street === ba.street) return common >= 1;
  // no address to compare (one or both missing): the project names have to say the same thing, every meaningful word of the shorter one
  return common >= 1 && common === Math.min(wa.length, wb.length);
}
