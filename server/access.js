// Who can use which part of the system. A person's role gives a default set of areas; the owner can turn areas off or on for one person
// (stored as users.access). An area the role does not normally have is lent for that area's pages only: the person acts with the
// lowest office role (Exec Assistant, or Estimator for estimating) there and nowhere else, so approving payments and owner-only settings
// are never opened up by an area switch.
import { HttpError } from './http.js';

export const AREAS = [
  ['estimating', 'Estimating (leads, proposals, follow-ups)'],
  ['projects', 'Job costing (projects, billing, contracts, change orders)'],
  ['billing', 'Invoice matching (QuickBooks)'],
  ['costs', 'Costs and receipts'],
  ['compliance', 'Compliance, notices and vendor payments'],
  ['reports', 'Reports'],
  ['lists', 'Admin lists (trades, GCs, vendors, employees)'],
];
export const AREA_IDS = AREAS.map(([id]) => id);
const OFFICE = ['estimating', 'projects', 'billing', 'costs', 'compliance', 'reports', 'lists'];
export const ROLE_AREAS = {
  'Super Admin': OFFICE, 'Sub Admin': OFFICE, 'Exec Assistant': OFFICE,
  Estimator: ['estimating', 'reports'], 'Project Manager': ['projects', 'reports'], Employee: [],
};
// What the dashboard cards belong to. A card with no area is for everyone (their own to-dos).
export const WIDGET_AREA = { estimating: 'estimating', presence: 'projects', costing: 'projects', chart: 'projects', forecast: 'projects', receivables: 'projects', payables: 'projects', projects: 'projects', compliance: 'compliance', overhead: 'costs', todos: null, messages: null };

const known = (list) => (Array.isArray(list) ? list.filter((a) => AREA_IDS.includes(a)) : null);
// The areas this person can use right now.
export function areasFor(user) {
  if (!user) return [];
  if (user.role === 'Super Admin') return AREA_IDS;
  const own = known(user.access?.areas);
  return own ?? ROLE_AREAS[user.role] ?? [];
}
export const can = (user, area) => areasFor(user).includes(area);
// Areas the person has that their role would not normally give (these are the ones that lend the role).
export const lentAreas = (user) => (user?.role === 'Super Admin' ? [] : areasFor(user).filter((a) => !(ROLE_AREAS[user?.role] ?? []).includes(a)));
export const hasLentManage = (user) => lentAreas(user).some((a) => ['projects', 'billing', 'costs', 'compliance', 'lists'].includes(a));

// Which pages belong to which area. Reading shared lists (trades, GCs and so on) stays open so forms keep working.
const RULES = [
  [/^\/api\/(opportunities|opportunity-files|followups|outbox|bids|regions|estimating|takeoff)(\/|$)/, 'estimating'],
  [/^\/api\/settings\/estimating$/, 'estimating'],
  [/^\/api\/quickbooks\/(invoices|sync|settings|review)(\/|$)/, 'billing'],
  [/^\/api\/projects\/[^/]+\/qb-suggestions$/, 'billing'],
  [/^\/api\/projects\/[^/]+\/nto$/, 'compliance'],
  [/^\/api\/(projects|contract-runs|contract-lines|invoice-schedule|trade-options|supplier-invoices)(\/|$)/, 'projects'],
  [/^\/api\/(receipts|overhead)(\/|$)/, 'costs'],
  [/^\/api\/(compliance|ntos|payment-requests)(\/|$)/, 'compliance'],
  [/^\/api\/reports(\/|$)/, 'reports'],
  [/^\/api\/admin\/(trades|gcs|subcontractors|suppliers|employees)(\/|$)/, 'lists', 'write'],
];
const LENT_ROLE = { estimating: 'Estimator' };   // everything else lends the lowest office role
export function areaOf(pathname, method) {
  for (const [re, area, only] of RULES) if (re.test(pathname) && (only !== 'write' || method !== 'GET')) return area;
  return null;
}
// Called for every request once the person is known. Throws when the area is off for them; returns the person, acting with the
// lent role when the area is one their role does not normally have.
export function gate(user, pathname, method) {
  if (!user) return user;
  const area = areaOf(pathname, method); if (!area) return user;
  if (!can(user, area)) throw new HttpError(403, 'You do not have access to this part of the system. Ask the owner.');
  if (user.role === 'Super Admin' || (ROLE_AREAS[user.role] ?? []).includes(area)) return user;
  return { ...user, role: LENT_ROLE[area] ?? 'Exec Assistant' };
}

// ---- storing the choice
export function parseAccess(v, widgetIds) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') throw new HttpError(400, 'Access is not valid.');
  const out = {};
  if (v.areas !== undefined && v.areas !== null) { if (!Array.isArray(v.areas) || v.areas.some((a) => !AREA_IDS.includes(a))) throw new HttpError(400, 'Choose areas from the list.'); out.areas = [...new Set(v.areas)]; }
  if (v.widgets !== undefined && v.widgets !== null) { if (!Array.isArray(v.widgets) || v.widgets.some((w) => !widgetIds.includes(w))) throw new HttpError(400, 'Choose dashboard cards from the list.'); out.widgets = [...new Set(v.widgets)]; }
  return Object.keys(out).length ? out : null;
}
export const options = (widgets) => ({ areas: AREAS.map(([id, label]) => ({ id, label })), roleAreas: ROLE_AREAS, widgets });
