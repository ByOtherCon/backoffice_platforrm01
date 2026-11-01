// The bid inbox rules, exactly as the tooltip on the Bid Opportunities page states them.
import { shift, todayEastern } from './estimating.ts';

// What the app calls a lead, as the user sees it.
export const statusLabel = (status: string): 'New' | 'Reviewing' | 'Accepted' | 'Declined' =>
  status === 'New' ? 'New' : status === 'Reviewing' ? 'Reviewing' : status === 'No Bid' ? 'Declined' : 'Accepted';

// New leads decline one day past their due date; Reviewing leads two days past. Leads with no due date never auto-decline.
export const declineAfterDays = (status: string): number | null => (status === 'New' ? 1 : status === 'Reviewing' ? 2 : null);
export function autoDeclineDue(status: string, due: string | null, today = todayEastern()): boolean {
  const d = declineAfterDays(status); if (d === null || !due) return false;
  return today >= shift(due, d);
}
// Search covers every lead seen in the last 30 days, declined ones included. Older leads must be added by hand.
export const SEARCH_DAYS = 30;
export const withinSearchWindow = (lastSeen: Date | string, now = new Date()): boolean => now.getTime() - new Date(lastSeen).getTime() <= SEARCH_DAYS * 86400000;

// Ranking inside a week: region tier, then shopping-center jobs, then project type.
export const TYPE_ORDER = ['Retail', 'Restaurant', 'Office / Medical / Other'];
export const rankLeads = <T extends { tier: number; mall: boolean; type: string; name: string; gc: string }>(a: T, b: T) =>
  a.tier - b.tier || Number(b.mall) - Number(a.mall) || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name) || a.gc.localeCompare(b.gc);
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const tierFor = (city: string | null, map: Record<string, number>): number => map[norm(city || '')] ?? 3;
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
  if (norm(a.city || '') !== norm(b.city || '')) return false;
  const aa = addressParts(a.address), ba = addressParts(b.address); if (aa.unit && ba.unit && aa.unit !== ba.unit) return false;
  if (norm(a.name) === norm(b.name) && (!aa.street || !ba.street || aa.street === ba.street)) return true;
  return !!aa.street && aa.street === ba.street && words(a.name).filter((t) => words(b.name).includes(t)).length >= 1;
}
