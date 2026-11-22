// Tracking numbers on purchases. A tracking number is entered with a vendor invoice or receipt (or added to one later, or to a project
// before the invoice is in). The app registers it with the tracking service (EasyPost: one tracker per package, the carrier worked out
// from the number), asks for its status every hour, and when the package is delivered, is ready for pickup, or runs into a problem,
// everyone on the project gets an alert that opens the project. Needs EASYPOST_API_KEY on the server; without it the numbers are still
// kept, with a link to the carrier's own tracking page.
import { q } from './db.js';
import { bad, text, HttpError } from './http.js';
import { notifyUser } from './compliance.js';

let fetchImpl = (...a) => fetch(...a);
export const setTrackingFetch = (f) => { fetchImpl = f; };   // tests stand in for the tracking service
export const connected = () => !!process.env.EASYPOST_API_KEY;
const MANAGE = ['Super Admin', 'Sub Admin', 'Exec Assistant'];

// ---------------------------------------------------------------- the carrier, from the number itself
export function carrierOf(raw) {
  const n = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return 'UPS';
  if (/^(94|93|92|95|42)\d{18,32}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return 'USPS';
  if (/^\d{12}$|^\d{15}$|^\d{20}$|^96\d{20}$|^\d{22}$/.test(n)) return 'FedEx';
  if (/^\d{10}$/.test(n) || /^JJD\d+$/.test(n)) return 'DHL';
  return null;
}
const LINKS = { UPS: 'https://www.ups.com/track?tracknum=', FedEx: 'https://www.fedex.com/fedextrack/?trknbr=', USPS: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=', DHL: 'https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=' };
export const carrierLink = (carrier, number) => (LINKS[carrier] ? LINKS[carrier] + encodeURIComponent(String(number).replace(/\s/g, '')) : null);

// ---------------------------------------------------------------- the tracking service
const STATUS = { pre_transit: 'Label created', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', available_for_pickup: 'Ready for pickup',
  return_to_sender: 'Problem: returning to sender', failure: 'Problem: delivery failed', cancelled: 'Cancelled', error: 'Problem: carrier error', unknown: 'Waiting for the carrier' };
async function service(method, path, body) {
  const res = await fetchImpl('https://api.easypost.com/v2' + path, { method, signal: AbortSignal.timeout(30000), headers: { authorization: 'Basic ' + Buffer.from(process.env.EASYPOST_API_KEY + ':').toString('base64'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `The tracking service would not take this (${res.status}${j?.error?.message ? ': ' + String(j.error.message).slice(0, 200) : ''}).`);
  return j;
}
const EP_CARRIER = { UPS: 'UPS', FedEx: 'FedEx', USPS: 'USPS', DHL: 'DHLExpress' };
// What a tracker says, in the app's words
const read = (t) => {
  const done = [...(t.tracking_details || [])].reverse().find((d) => d.status === 'delivered');
  return { status: STATUS[t.status] || 'Waiting for the carrier', detail: t.status_detail && t.status_detail !== 'unknown' ? String(t.status_detail).replace(/_/g, ' ') : null, est: t.est_delivery_date ? String(t.est_delivery_date).slice(0, 10) : null,
    deliveredAt: t.status === 'delivered' ? (done?.datetime || t.updated_at || new Date().toISOString()) : null, url: t.public_url || null, serviceId: t.id || null, carrier: t.carrier || null };
};
async function save(id, r) {
  await q(`UPDATE shipments SET status=$2, status_detail=$3, est_delivery=$4, delivered_at=COALESCE(delivered_at,$5), public_url=COALESCE($6,public_url), service_id=COALESCE($7,service_id), checked_at=now() WHERE id=$1`, [id, r.status, r.detail, r.est, r.deliveredAt, r.url, r.serviceId]);
}

// ---------------------------------------------------------------- who may see and add tracking numbers
async function projectsOf(s) {
  if (s.project_id) return [s.project_id];
  return (await q('SELECT DISTINCT project_id FROM supplier_allocations WHERE supplier_invoice_id=$1 AND project_id IS NOT NULL', [s.supplier_invoice_id])).map((r) => r.project_id);
}
async function mayWork(user, projectIds) {
  if (MANAGE.includes(user.role)) return;
  if (user.role === 'Project Manager' && projectIds.length && (await q('SELECT 1 FROM project_members WHERE user_id=$1 AND project_id = ANY($2::uuid[])', [user.id, projectIds])).length) return;
  throw new HttpError(403, 'Only the office or a project manager on this job can do that.');
}

// ---------------------------------------------------------------- adding, listing, removing
// One or several numbers (separated by commas, spaces or new lines) on a vendor invoice or receipt, or on a project.
export async function addShipments(user, b = {}) {
  const invoiceId = b.supplierInvoiceId || null, projectId = invoiceId ? null : b.projectId || null;
  if (!invoiceId && !projectId) throw bad('Choose the vendor invoice, or the project the purchase is for.');
  if (invoiceId && !(await q('SELECT 1 FROM supplier_invoices WHERE id=$1', [invoiceId])).length) throw new HttpError(404, 'Vendor invoice not found.');
  if (projectId && !(await q('SELECT 1 FROM projects WHERE id=$1', [projectId])).length) throw new HttpError(404, 'Project not found.');
  await mayWork(user, invoiceId ? await projectsOf({ supplier_invoice_id: invoiceId }) : [projectId]);
  const numbers = [...new Set(String(b.numbers ?? b.number ?? '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!numbers.length) throw bad('Enter the tracking number.'); if (numbers.length > 20) throw bad('Up to 20 tracking numbers at a time.');
  for (const n of numbers) if (!/^[A-Z0-9]{8,40}$/.test(n)) throw bad(`${n} does not look like a tracking number (letters and numbers only, 8 to 40 of them).`);
  const description = text(b.description, 'Description', { max: 300, required: false }) || null, given = b.carrier ? text(b.carrier, 'Carrier', { max: 40 }) : null;
  const out = [];
  for (const n of numbers) {
    const [dup] = await q(`SELECT id FROM shipments WHERE tracking_number=$1 AND (supplier_invoice_id IS NOT DISTINCT FROM $2) AND (project_id IS NOT DISTINCT FROM $3)`, [n, invoiceId, projectId]);
    if (dup) { out.push(dup.id); continue; }
    const carrier = given || carrierOf(n);
    const [s] = await q('INSERT INTO shipments(supplier_invoice_id,project_id,tracking_number,carrier,description,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [invoiceId, projectId, n, carrier, description, user.id]);
    out.push(s.id); await register(s.id).catch((e) => q('UPDATE shipments SET status_detail=$2 WHERE id=$1', [s.id, String(e.message).slice(0, 300)]));
  }
  return { ids: out, connected: connected() };
}
// Registers a tracking number with the service and reads its first status. Nothing happens without the key.
async function register(id) {
  if (!connected()) return;
  const [s] = await q('SELECT * FROM shipments WHERE id=$1', [id]); if (!s || s.service_id) return;
  const t = await service('POST', '/trackers', { tracker: { tracking_code: s.tracking_number, ...(EP_CARRIER[s.carrier] ? { carrier: EP_CARRIER[s.carrier] } : {}) } }), r = read(t);
  if (!s.carrier && r.carrier) await q('UPDATE shipments SET carrier=$2 WHERE id=$1', [id, r.carrier]);
  await save(id, r); await alertIfNeeded(id);
}
const view = (s) => ({ id: s.id, number: s.tracking_number, carrier: s.carrier, description: s.description || s.invoice_description || null, status: s.status, detail: s.status_detail, estDelivery: s.est_delivery ? String(s.est_delivery instanceof Date ? s.est_delivery.toISOString() : s.est_delivery).slice(0, 10) : null,
  deliveredAt: s.delivered_at, checkedAt: s.checked_at, link: s.public_url || carrierLink(s.carrier, s.tracking_number), invoiceId: s.supplier_invoice_id, vendor: s.vendor ?? null, reference: s.reference ?? null, by: s.by ?? null, at: s.created_at });
const LIST = `SELECT s.*, sup.name AS vendor, i.reference, i.description AS invoice_description, u.name AS by FROM shipments s LEFT JOIN supplier_invoices i ON i.id=s.supplier_invoice_id LEFT JOIN suppliers sup ON sup.id=i.supplier_id LEFT JOIN app_users u ON u.id=s.created_by`;
// A project's packages: those on its vendor invoices and those added to it directly. Not delivered first.
export async function projectShipments(projectId) {
  const rows = await q(`${LIST} WHERE s.project_id=$1 OR s.supplier_invoice_id IN (SELECT supplier_invoice_id FROM supplier_allocations WHERE project_id=$1) ORDER BY (s.delivered_at IS NOT NULL), s.created_at DESC`, [projectId]);
  return { connected: connected(), shipments: rows.map(view) };
}
export async function invoiceShipments(user, invoiceId) {
  await mayWork(user, await projectsOf({ supplier_invoice_id: invoiceId }));
  return { connected: connected(), shipments: (await q(`${LIST} WHERE s.supplier_invoice_id=$1 ORDER BY s.created_at`, [invoiceId])).map(view) };
}
export async function removeShipment(user, id) {
  const [s] = await q('SELECT * FROM shipments WHERE id=$1', [id]); if (!s) throw new HttpError(404, 'Tracking number not found.');
  await mayWork(user, await projectsOf(s)); await q('DELETE FROM shipments WHERE id=$1', [id]); return { ok: true };
}
// "Check Now": asks the service for this package straight away
export async function checkOne(user, id) {
  const [s] = await q('SELECT * FROM shipments WHERE id=$1', [id]); if (!s) throw new HttpError(404, 'Tracking number not found.');
  await mayWork(user, await projectsOf(s));
  if (!connected()) throw new HttpError(503, 'The tracking service is not connected yet. The owner adds EASYPOST_API_KEY on the server; until then use the carrier link.');
  if (!s.service_id) await register(id); else { await save(id, read(await service('GET', `/trackers/${encodeURIComponent(s.service_id)}`))); await alertIfNeeded(id); }
  const [row] = await q(`${LIST} WHERE s.id=$1`, [id]); return view(row);
}

// ---------------------------------------------------------------- every hour: every package not delivered yet (for 60 days)
export async function checkAll() {
  if (!connected()) return { checked: 0 };
  const open = await q(`SELECT id, service_id FROM shipments WHERE delivered_at IS NULL AND created_at > now() - interval '60 days' AND status NOT IN ('Cancelled') ORDER BY checked_at NULLS FIRST LIMIT 200`);
  let n = 0;
  for (const s of open) { try { if (!s.service_id) await register(s.id); else { await save(s.id, read(await service('GET', `/trackers/${encodeURIComponent(s.service_id)}`))); await alertIfNeeded(s.id); } n++; } catch (e) { await q('UPDATE shipments SET status_detail=$2, checked_at=now() WHERE id=$1', [s.id, String(e.message).slice(0, 300)]).catch(() => {}); } }
  return { checked: n };
}
export function startScheduler() { setTimeout(() => checkAll().catch(() => {}), 60000); setInterval(() => checkAll().catch((e) => console.error('tracking', e.message)), 3600000); }

// ---------------------------------------------------------------- the alert: to the person who added it, the project's managers and the office
async function alertIfNeeded(id) {
  const [s] = await q(`${LIST} WHERE s.id=$1`, [id]); if (!s) return;
  const kind = s.status === 'Delivered' ? 'Delivered' : s.status === 'Ready for pickup' ? 'Ready for pickup' : /^Problem/.test(s.status) ? 'Problem' : null;
  if (!kind || s.alerted === kind) return;
  const pids = await projectsOf(s), projects = pids.length ? await q('SELECT id, name, ref_code FROM projects WHERE id = ANY($1::uuid[]) ORDER BY name', [pids]) : [];
  const where = projects.map((p) => [p.ref_code, p.name].filter(Boolean).join(' ')).join(', ') || 'no project', what = [s.vendor, s.reference ? `#${s.reference}` : null, s.description || s.invoice_description].filter(Boolean).join(' ') || `package ${s.tracking_number}`;
  const title = kind === 'Delivered' ? `Delivered: ${what} for ${where}` : kind === 'Ready for pickup' ? `Ready for pickup: ${what} for ${where}` : `Delivery problem: ${what} for ${where}`;
  const body = `${s.carrier || 'Carrier'} ${s.tracking_number}: ${s.status}${s.status_detail && kind !== 'Delivered' ? ` (${s.status_detail})` : ''}${kind === 'Delivered' && s.delivered_at ? `, ${new Date(s.delivered_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.`;
  const users = await q(`SELECT DISTINCT id FROM app_users WHERE active AND (id=$1 OR role = ANY($2::text[]) OR id IN (SELECT user_id FROM project_members WHERE project_id = ANY($3::uuid[])))`, [s.created_by, MANAGE, pids]);
  const link = projects.length ? `#/projects/${projects[0].id}/costs` : '#/projects/receipts';
  for (const u of users) await notifyUser(u.id, { kind: 'Delivery', title, body, link, dedupe: `shipment:${s.id}:${kind}` });
  await q('UPDATE shipments SET alerted=$2 WHERE id=$1', [s.id, kind]);
}
