import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { HttpError, readJson, readRaw, send, bad } from './http.js';
import * as auth from './auth.js';
import * as admin from './admin.js';
import * as pj from './projectApi.js';
import * as bl from './billingApi.js';
import * as tc from './timeclock.js';
import * as cp from './compliance.js';
import * as ap from './approvals.js';
import * as dc from './documents.js';
import * as rc from './receipts.js';
import * as ai from './ai.js';
import * as oh from './overheadApi.js';
import * as ms from './messaging.js';
import * as es from './estimating.js';
import * as fu from './followups.js';
import * as aiu from './aiUsage.js';
import * as folders from './folders.js';
import * as sharepoint from './sharepoint.js';
import { verifyAddress } from './address.js';
import * as db from './dashboard.js';
import * as rp from './reports.js';
import * as tk from './takeoff.js';
import * as bd from './bids.js';
import * as pw from './passwords.js';
import * as ct from './contracts.js';
import * as qbo from './quickbooks.js';
import * as qbi from './qbImport.js';
import * as acc from './access.js';
import * as gl from './googleLogin.js';
import { bootstrapOwner } from './bootstrap.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SECURE = process.env.NODE_ENV === 'production';
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ ...opts, method, re: new RegExp('^' + pattern.replace(/:[a-z]+/gi, '([^/]+)') + '$'), names: [...pattern.matchAll(/:([a-z]+)/gi)].map((m) => m[1]), handler });
const uuid = (v) => { if (!/^[0-9a-f-]{36}$/i.test(v)) throw new HttpError(404, 'Not found.'); return v; };
const manage = (u) => { auth.requireRole(u, auth.MANAGE); };
const adminOnly = (u) => { auth.requireRole(u, auth.SUPER); };

route('POST', '/api/login', async ({ body, res }) => {
  const { token, user } = await auth.login(body.email, body.password);
  send(res, 200, { user }, { 'set-cookie': auth.sessionCookie(token, SECURE) });
  return 'sent';
});
// Sign in with Google (company Workspace accounts only). These pages are public: the person is not signed in yet.
route('GET', '/api/auth/options', async () => gl.options());
route('GET', '/api/auth/google/start', async ({ res }) => { const s = gl.start(SECURE); res.writeHead(302, { location: s.url, 'set-cookie': s.setCookie, 'cache-control': 'no-store' }); res.end(); return 'sent'; });
route('GET', '/api/auth/google/callback', async ({ req, res }) => {
  const p = new URL(req.url, 'http://x').searchParams;
  const r = p.get('error') ? { error: 'Google did not allow the sign-in.' } : await gl.finish(req, p.get('code'), p.get('state'));
  const headers = { 'cache-control': 'no-store', 'set-cookie': [gl.clearNonce(SECURE)], location: '/#/dashboard' };
  if (r.token) headers['set-cookie'].push(auth.sessionCookie(r.token, SECURE)); else headers.location = '/?login_error=' + encodeURIComponent(r.error);
  res.writeHead(302, headers); res.end(); return 'sent';
});
route('POST', '/api/logout', async ({ user, res }) => { if (user) await auth.logout(user.token); send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(SECURE) }); return 'sent'; });
route('GET', '/api/me', async ({ user }) => { if (!user) throw new HttpError(401, 'Sign in required.'); return { user: { id: user.id, email: user.email, name: user.name, role: user.role, areas: acc.areasFor(user), clock: !!user.linkedEmployeeId } }; });
route('GET', '/api/access/options', async ({ user }) => { auth.requireRole(user, auth.SUPER); return acc.options(db.widgetList()); });

route('POST', '/api/me/password', async ({ user, body }) => { if (!user) throw new HttpError(401, 'Sign in required.'); return pw.changeOwn(user, body.current, body.next); });
route('POST', '/api/password/forgot', async ({ body }) => pw.requestReset(body.email));
route('GET', '/api/password/reset/:token', async ({ params }) => pw.checkReset(params.token));
route('POST', '/api/password/reset', async ({ body }) => pw.finishReset(body.token, body.password));

// Admin: master records
for (const kind of Object.keys(admin.KINDS)) {
  route('GET', `/api/admin/${kind}`, async ({ user }) => { auth.requireRole(user, [...auth.MANAGE, 'Project Manager']); return admin.list(kind, { rates: auth.SUPER.includes(user.role) }); });
  route('POST', `/api/admin/${kind}`, async ({ user, body }) => { manage(user); if (admin.touchesPay(kind, body)) auth.requireRole(user, auth.SUPER); return admin.create(kind, body); });
  route('PUT', `/api/admin/${kind}/:id`, async ({ user, body, params }) => { manage(user); if (admin.touchesPay(kind, body)) auth.requireRole(user, auth.SUPER); return admin.update(kind, uuid(params.id), body); });
  route('DELETE', `/api/admin/${kind}/:id`, async ({ user, params }) => { manage(user); await admin.remove(kind, uuid(params.id)); return { ok: true }; });
}
route('GET', '/api/admin/users', async ({ user }) => { adminOnly(user); return admin.listUsers(); });
route('POST', '/api/admin/users', async ({ user, body }) => { adminOnly(user); return admin.createUser(body); });
route('PUT', '/api/admin/users/:id', async ({ user, body, params }) => { adminOnly(user); return admin.updateUser(uuid(params.id), body, user.id); });

// People who can be assigned estimating work: the owner, Sub Admins, and Estimators
route('GET', '/api/team/estimators', async ({ user }) => { auth.requireRole(user, [...auth.MANAGE, 'Estimator', 'Project Manager']); return q(`SELECT id, name, email, title FROM app_users WHERE active AND role IN ('Super Admin','Sub Admin','Estimator') ORDER BY name`); });

// Dashboard and projects
route('GET', '/api/dashboard', async ({ user }) => { auth.requireRole(user, [...auth.MANAGE, 'Project Manager', 'Estimator']); return pj.dashboard(user, auth.MANAGE.includes(user.role)); });
route('GET', '/api/projects', async ({ user }) => { auth.requireRole(user, [...auth.MANAGE, 'Project Manager']); return pj.listProjects(user, auth.MANAGE.includes(user.role)); });
route('POST', '/api/projects', async ({ user, body }) => { manage(user); return pj.createProject(body); });
route('GET', '/api/projects/:id', async ({ user, params }) => { await auth.requireProject(user, uuid(params.id)); return pj.getProject(params.id); });
route('PUT', '/api/projects/:id', async ({ user, params, body }) => { manage(user); await pj.updateProject(uuid(params.id), body); return { ok: true }; });
route('POST', '/api/projects/:id/trades', async ({ user, params, body }) => { manage(user); await pj.addTrade(uuid(params.id), body); return { ok: true }; });
route('PUT', '/api/projects/:id/trades/:tid', async ({ user, params, body }) => { manage(user); await pj.setTradeAmount(uuid(params.id), uuid(params.tid), body); return { ok: true }; });
route('DELETE', '/api/projects/:id/trades/:tid', async ({ user, params }) => { manage(user); await pj.removeTrade(uuid(params.id), uuid(params.tid)); return { ok: true }; });
route('POST', '/api/projects/:id/change-orders', async ({ user, params, body }) => { await auth.requireProject(user, uuid(params.id)); return pj.addChangeOrder(params.id, body); });
route('PUT', '/api/projects/:id/change-orders/:cid', async ({ user, params, body }) => { await auth.requireProject(user, uuid(params.id)); await pj.updateChangeOrder(params.id, uuid(params.cid), body); return { ok: true }; });
route('DELETE', '/api/projects/:id/change-orders/:cid', async ({ user, params }) => { await auth.requireProject(user, uuid(params.id)); await pj.deleteChangeOrder(params.id, uuid(params.cid)); return { ok: true }; });

// Progress billing and costs. Reads: Admin/Sub-Admin/Office or an assigned PM. Writes: Admin/Sub-Admin/Office only.
const view = async (user, params) => { await auth.requireProject(user, uuid(params.id)); return params.id; };
const write = (user, params) => { manage(user); return uuid(params.id); };
route('GET', '/api/projects/:id/billing', async ({ user, params }) => bl.getBilling(await view(user, params)));
route('POST', '/api/projects/:id/invoices', async ({ user, params, body }) => bl.addInvoice(write(user, params), body));
route('PUT', '/api/projects/:id/invoices/:iid', async ({ user, params, body }) => { await bl.updateInvoice(write(user, params), uuid(params.iid), body); return { ok: true }; });
route('DELETE', '/api/projects/:id/invoices/:iid', async ({ user, params }) => { await bl.deleteInvoice(write(user, params), uuid(params.iid)); return { ok: true }; });
route('POST', '/api/projects/:id/invoices/:iid/payments', async ({ user, params, body }) => { await bl.addClientPayment(write(user, params), uuid(params.iid), body); return { ok: true }; });
route('DELETE', '/api/projects/:id/invoices/:iid/payments/:pid', async ({ user, params }) => { await bl.deleteClientPayment(write(user, params), uuid(params.iid), uuid(params.pid)); return { ok: true }; });
route('GET', '/api/projects/:id/costs', async ({ user, params }) => bl.getCosts(await view(user, params), { rates: auth.SUPER.includes(user.role) }));
route('POST', '/api/projects/:id/commitments', async ({ user, params, body }) => bl.addCommitment(write(user, params), body));
route('PUT', '/api/projects/:id/commitments/:cid', async ({ user, params, body }) => { await bl.updateCommitment(write(user, params), uuid(params.cid), body); return { ok: true }; });
route('DELETE', '/api/projects/:id/commitments/:cid', async ({ user, params }) => { await bl.deleteCommitment(write(user, params), uuid(params.cid)); return { ok: true }; });
route('POST', '/api/projects/:id/commitments/:cid/bills', async ({ user, params, body }) => bl.addSubBill(write(user, params), uuid(params.cid), body));
route('DELETE', '/api/projects/:id/commitments/:cid/bills/:bid', async ({ user, params }) => { await bl.deleteSubBill(write(user, params), uuid(params.cid), uuid(params.bid)); return { ok: true }; });
route('POST', '/api/projects/:id/sub-bills/:bid/payments', async ({ user, params, body }) => { auth.requireRole(user, auth.APPROVERS); await bl.addSubPayment(write(user, params), uuid(params.bid), body); return { ok: true }; });
route('POST', '/api/projects/:id/sub-bills/:bid/payment-requests', async ({ user, params, body }) => ap.requestPayment(user, write(user, params), uuid(params.bid), body));
route('DELETE', '/api/projects/:id/sub-payments/:pid', async ({ user, params }) => { await bl.deleteSubPayment(write(user, params), uuid(params.pid)); return { ok: true }; });
route('POST', '/api/supplier-invoices', async ({ user, body }) => { manage(user); return bl.addSupplierInvoice(body); });
route('DELETE', '/api/supplier-invoices/:id', async ({ user, params }) => { manage(user); await bl.deleteSupplierInvoice(uuid(params.id)); return { ok: true }; });
route('POST', '/api/supplier-invoices/:id/payments', async ({ user, params, body }) => { manage(user); await bl.addSupplierPayment(uuid(params.id), body); return { ok: true }; });

// Time clock. Employees sign in with a PIN (separate from office logins); the office sees and corrects entries.
const emp = (u) => { if (!u || u.role !== 'Employee') throw new HttpError(401, 'Sign in with your PIN.'); return u.employeeId; };
route('GET', '/api/clock/roster', async () => tc.roster());
route('POST', '/api/clock/login', async ({ body, res }) => { const r = await tc.clockLogin(body.employeeId, body.pin); send(res, 200, { employee: r.employee }, { 'set-cookie': auth.sessionCookie(r.token, SECURE) }); return 'sent'; });
// The same clock, from inside the platform, for a login that is linked to an employee (Admin → Company → Users & access).
const myClock = (u) => { if (!u?.id) throw new HttpError(401, 'Sign in required.'); if (!u.linkedEmployeeId) throw new HttpError(403, 'Your login is not linked to a time clock employee. Ask the owner to link it.'); return u.linkedEmployeeId; };
route('GET', '/api/me/clock/home', async ({ user }) => tc.clockHome(myClock(user)));
route('POST', '/api/me/clock/in', async ({ user, body }) => tc.clockIn(myClock(user), body));
route('POST', '/api/me/clock/out', async ({ user, body }) => tc.clockOut(myClock(user), body));
route('POST', '/api/me/clock/manual', async ({ user, body }) => tc.manualEntry(myClock(user), body));
route('GET', '/api/clock/home', async ({ user }) => tc.clockHome(emp(user)));
route('POST', '/api/clock/in', async ({ user, body }) => tc.clockIn(emp(user), body));
route('POST', '/api/clock/out', async ({ user, body }) => tc.clockOut(emp(user), body));
route('POST', '/api/clock/manual', async ({ user, body }) => tc.manualEntry(emp(user), body));
route('GET', '/api/time/active', async ({ user }) => { auth.requireRole(user, [...auth.MANAGE, 'Project Manager']); return tc.activeNow(); });
route('GET', '/api/time/entries', async ({ req, user }) => { manage(user); const u = new URL(req.url, 'http://x').searchParams; return tc.listEntries({ from: u.get('from'), to: u.get('to'), employeeId: u.get('employeeId'), projectId: u.get('projectId') }); });
route('PUT', '/api/time/entries/:id', async ({ user, params, body }) => { manage(user); await tc.editEntry(uuid(params.id), body, user.id); return { ok: true }; });
route('DELETE', '/api/time/entries/:id', async ({ user, params }) => { manage(user); await tc.deleteEntry(uuid(params.id)); return { ok: true }; });
route('PUT', '/api/admin/employees/:id/pin', async ({ user, params, body }) => { manage(user); await tc.setPin(uuid(params.id), body.pin); return { ok: true }; });
route('GET', '/api/settings/timeclock', async ({ user }) => { manage(user); return tc.getSettings(); });
route('PUT', '/api/settings/timeclock', async ({ user, body }) => { auth.requireRole(user, auth.APPROVERS); return tc.saveSettings(body); });
route('POST', '/api/time/recalculate', async ({ user }) => { auth.requireRole(user, auth.APPROVERS); return tc.recalcAll(); });

// Compliance, approvals, notifications, notices to owner
route('GET', '/api/compliance/vendors', async ({ user }) => { manage(user); return cp.vendorCompliance(); });
route('POST', '/api/admin/subcontractors/:id/documents', async ({ user, params, body }) => { manage(user); return cp.setVendorDoc(uuid(params.id), body); });
route('DELETE', '/api/admin/subcontractors/:id/documents/:cat', async ({ user, params }) => { manage(user); await cp.clearVendorDoc(uuid(params.id), decodeURIComponent(params.cat)); return { ok: true }; });
route('POST', '/api/compliance/scan', async ({ user }) => { manage(user); const a = await cp.scan(), b = await cp.scanNtos(); return { ...a, ntos: b, ...(await cp.sendQueued()) }; });
route('GET', '/api/payment-requests', async ({ req, user }) => { manage(user); const u = new URL(req.url, 'http://x').searchParams; return ap.listRequests({ status: u.get('status'), projectId: u.get('projectId') }); });
route('POST', '/api/payment-requests/:id/approve', async ({ user, params }) => { auth.requireRole(user, auth.APPROVERS); await ap.approve(user, uuid(params.id)); return { ok: true }; });
route('POST', '/api/payment-requests/:id/reject', async ({ user, params, body }) => { auth.requireRole(user, auth.APPROVERS); await ap.reject(user, uuid(params.id), body.reason); return { ok: true }; });
route('POST', '/api/payment-requests/:id/pay', async ({ user, params, body }) => { manage(user); await ap.pay(user, uuid(params.id), body); return { ok: true }; });
route('DELETE', '/api/payment-requests/:id', async ({ user, params }) => { manage(user); await ap.cancel(user, uuid(params.id)); return { ok: true }; });
route('GET', '/api/notifications', async ({ user }) => { if (!user?.id) throw new HttpError(401, 'Sign in required.'); return cp.listNotifications(user.id); });
route('POST', '/api/notifications/read', async ({ user, body }) => { if (!user?.id) throw new HttpError(401, 'Sign in required.'); await cp.markRead(user.id, body.all ? 'all' : (body.ids || []).map(uuid)); return { ok: true }; });
route('GET', '/api/outbox', async ({ user }) => { manage(user); return { connected: cp.emailConnected(), emails: await cp.listOutbox() }; });
route('POST', '/api/outbox/send', async ({ user }) => { auth.requireRole(user, auth.APPROVERS); return cp.sendQueued(); });
route('POST', '/api/outbox/:id/retry', async ({ user, params }) => { auth.requireRole(user, auth.APPROVERS); await cp.retryEmail(uuid(params.id)); return { ok: true }; });
route('GET', '/api/ntos', async ({ req, user }) => { auth.requireRole(user, [...auth.MANAGE, 'Project Manager']); return cp.listNtos(new URL(req.url, 'http://x').searchParams.get('year')); });
route('GET', '/api/projects/:id/nto', async ({ user, params }) => { await auth.requireProject(user, uuid(params.id)); return cp.getNto(params.id); });
route('PUT', '/api/projects/:id/nto', async ({ user, params, body }) => { manage(user); await cp.updateNto(uuid(params.id), body); return { ok: true }; });

// Health check for the host: confirms the app is up and can reach the database. Reveals nothing else.
route('GET', '/api/health', async () => { await q('SELECT 1'); return { ok: true }; });

// Dashboard widgets and saved layouts (per user)
route('GET', '/api/dashboard/widgets', async ({ user, req }) => { auth.requireRole(user, [...auth.MANAGE, 'Estimator', 'Project Manager']); return { ...(await db.widgetData(user, { period: q1(req, 'period') || 'month' })), all: db.WIDGETS, prefs: await db.getPrefs(user, 'dashboard') }; });
route('GET', '/api/prefs/:key', async ({ user, params }) => { if (!user?.id) throw new HttpError(401, 'Sign in required.'); return (await db.getPrefs(user, params.key)) ?? {}; });
route('PUT', '/api/prefs/:key', async ({ user, params, body }) => { if (!user?.id) throw new HttpError(401, 'Sign in required.'); return db.savePrefs(user, params.key, body); });

// Reports: any source, filtered / grouped / totaled, exported as CSV. Each source lists the roles allowed to see it.
const rpUser = (u) => { auth.requireRole(u, [...auth.MANAGE, 'Estimator', 'Project Manager']); return u; };
route('GET', '/api/reports/sources', async ({ user }) => ({ sources: rp.listSources(rpUser(user)), presets: rp.PRESETS.filter((p) => rp.listSources(user).some((s) => s.id === p.source)) }));
route('POST', '/api/reports/run', async ({ user, body }) => rp.run(rpUser(user), body));
route('POST', '/api/reports/export', async ({ user, body, res }) => { const f = await rp.exportCsv(rpUser(user), body); res.writeHead(200, { ...SEC, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' }); res.end(f.body); return 'sent'; });

// Estimating. Read: management and estimators. Write: Super Admin, Sub Admin, Estimator.
const estRead = (u) => { auth.requireRole(u, [...auth.MANAGE, 'Estimator']); return u; };
const estWrite = (u) => { auth.requireRole(u, es.EST_ROLES); return u; };
route('GET', '/api/estimating/options', async ({ user }) => { estRead(user); return es.options(); });
route('GET', '/api/gcs/known', async ({ user }) => { estRead(user); return es.knownGcs(); });
// Every address box in the app (projects, vendors, subcontractors, the estimating form) checks itself here. Any signed-in office user may.
route('POST', '/api/address/verify', async ({ user, body }) => {
  if (!user) throw new HttpError(401, 'Sign in required.'); if (user.role === 'Employee') throw new HttpError(403, 'Not allowed.');
  const kind = ['gc', 'project', 'other'].includes(body.kind) ? body.kind : 'project'; const label = { gc: 'GC address', project: 'Project address', other: 'Address' }[kind];
  return verifyAddress(body, { florida: kind === 'project', label });
});
route('GET', '/api/opportunities', async ({ req, user }) => { estRead(user); return es.list({ tab: q1(req, 'tab'), search: q1(req, 'q'), showAll: q1(req, 'all') === '1', filter: q1(req, 'filter'), scope: q1(req, 'scope'), userId: user.id }); });
route('POST', '/api/opportunities', async ({ user, body }) => es.create(estWrite(user), body));
route('POST', '/api/opportunities/import', async ({ user, body }) => es.importLeads(estWrite(user), body));
route('GET', '/api/opportunities/:id', async ({ user, params }) => { estRead(user); return es.get(uuid(params.id)); });
route('PUT', '/api/opportunities/:id', async ({ user, params, body }) => { await es.update(estWrite(user), uuid(params.id), body); return { ok: true }; });
route('GET', '/api/opportunities/:id/folder-files', async ({ user, params }) => { estRead(user); return folders.folderFiles(uuid(params.id)); });
route('POST', '/api/opportunities/:id/folder', async ({ user, params }) => { estWrite(user); return folders.ensureOpportunityFolder(uuid(params.id)); });
route('POST', '/api/projects/:id/folder', async ({ user, params }) => { manage(user); return folders.ensureProjectFolder(uuid(params.id)); });
route('GET', '/api/quickbooks/status', async ({ user }) => { auth.requireRole(user, auth.SUPER); return { ...(await qbo.status()), lastSync: await qbi.lastSync(), counts: await qbi.counts(), settings: await qbi.getSettings() }; });
// What the invoice-matching page needs to know, for anyone with that area (no keys, no connection controls).
route('GET', '/api/quickbooks/review', async ({ user }) => { manage(user); const st = await qbo.status(); return { configured: st.configured, connected: st.connected, company: st.company, environment: st.environment, connectedEnvironment: st.connectedEnvironment, lastSync: await qbi.lastSync(), counts: await qbi.counts(), settings: await qbi.getSettings() }; });
route('GET', '/api/quickbooks/invoices', async ({ req, user }) => { manage(user); return qbi.list(q1(req, 'status') || 'New', q1(req, 'search') || ''); });
route('GET', '/api/quickbooks/settings', async ({ user }) => { manage(user); return qbi.getSettings(); });
route('PUT', '/api/quickbooks/settings', async ({ user, body }) => { manage(user); return qbi.saveSettings(body); });
route('POST', '/api/quickbooks/invoices/ignore-unmatched', async ({ user }) => { manage(user); return qbi.ignoreUnmatched(); });
route('GET', '/api/projects/:id/qb-suggestions', async ({ user, params }) => { manage(user); return qbi.projectSuggestions(uuid(params.id)); });
route('POST', '/api/quickbooks/sync', async ({ user }) => { manage(user); return qbi.sync(); });
route('GET', '/api/quickbooks/invoices/:id/prepare', async ({ req, user, params }) => { manage(user); return qbi.guessTrades(uuid(params.id), uuid(q1(req, 'projectId') || '')); });
route('PUT', '/api/quickbooks/invoices/:id/project', async ({ user, params, body }) => { manage(user); await qbi.setProject(uuid(params.id), body.projectId ? uuid(body.projectId) : null); return { ok: true }; });
route('POST', '/api/quickbooks/invoices/:id/import', async ({ user, params, body }) => { manage(user); return qbi.importInvoice(uuid(params.id), body); });
route('POST', '/api/quickbooks/invoices/:id/ignore', async ({ user, params }) => { manage(user); await qbi.ignore(uuid(params.id), true); return { ok: true }; });
route('POST', '/api/quickbooks/invoices/:id/restore', async ({ user, params }) => { manage(user); await qbi.ignore(uuid(params.id), false); return { ok: true }; });
route('GET', '/api/quickbooks/connect', async ({ user }) => { auth.requireRole(user, auth.SUPER); return { url: qbo.connectUrl(user) }; });
route('GET', '/api/quickbooks/callback', async ({ req, res, user }) => {
  auth.requireRole(user, auth.SUPER); const p = new URL(req.url, 'http://x').searchParams;
  if (p.get('error')) throw bad('Intuit did not allow the connection (' + p.get('error') + ').');
  await qbo.finishConnect(p.get('code'), p.get('state'), p.get('realmId')); qbi.sync().catch((e) => console.error('QuickBooks first sync', e.message)); res.writeHead(302, { location: '/#/admin/connections', 'cache-control': 'no-store' }); res.end(); return 'sent';
});
route('DELETE', '/api/quickbooks', async ({ user }) => { auth.requireRole(user, auth.SUPER); await qbo.disconnect(); return { ok: true }; });
route('GET', '/api/sharepoint/status', async ({ req, user }) => { auth.requireRole(user, [...auth.MANAGE, 'Estimator']); return q1(req, 'test') === '1' && auth.SUPER.includes(user.role) ? sharepoint.status() : { configured: sharepoint.configured() }; });
route('POST', '/api/opportunities/:id/status', async ({ user, params, body }) => es.transition(estWrite(user), uuid(params.id), body));
route('POST', '/api/opportunities/:id/notes', async ({ user, params, body }) => { await es.addUserNote(estWrite(user), uuid(params.id), body.body); return { ok: true }; });
route('POST', '/api/opportunities/:id/plans', async ({ req, user, params }) => es.uploadPlans(estWrite(user), uuid(params.id), req, fname(req)), { raw: true });
route('POST', '/api/opportunities/:id/files', async ({ req, user, params }) => es.uploadFile(estWrite(user), uuid(params.id), await readRaw(req), fname(req), q1(req, 'kind') || 'Proposal'), { raw: true });
route('DELETE', '/api/opportunities/:id/files/:fid', async ({ user, params }) => { await es.deleteFile(estWrite(user), uuid(params.id), uuid(params.fid)); return { ok: true }; });
route('GET', '/api/opportunity-files/:fid', async ({ res, user, params }) => {
  estRead(user); const d = await es.fileForDownload(uuid(params.fid)); if (!fs.existsSync(d.file)) throw new HttpError(404, 'File is missing from storage.');
  const inline = /^(application\/pdf|image\/)/.test(d.mime);
  res.writeHead(200, { ...SEC, 'content-type': d.mime, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`, 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" });
  fs.createReadStream(d.file).pipe(res); return 'sent';
});
route('PUT', '/api/opportunities/:id/trade-prices', async ({ user, params, body }) => { await es.setTradePrices(estWrite(user), uuid(params.id), body.prices); return { ok: true }; });
route('POST', '/api/opportunities/:id/submissions', async ({ user, params, body }) => es.addSubmission(estWrite(user), uuid(params.id), body));
route('PUT', '/api/opportunities/:id/submissions/:sid', async ({ user, params, body }) => { await es.editSubmission(estWrite(user), uuid(params.id), uuid(params.sid), body); return { ok: true }; });
route('POST', '/api/opportunities/:id/submissions/:sid/void', async ({ user, params, body }) => { await es.voidSubmission(estWrite(user), uuid(params.id), uuid(params.sid), body.reason); return { ok: true }; });
route('GET', '/api/followups', async ({ req, user }) => { estRead(user); return fu.list({ filter: q1(req, 'filter') }); });
route('GET', '/api/opportunities/:id/followup', async ({ user, params }) => { estRead(user); return fu.get(user, uuid(params.id)); });
route('POST', '/api/opportunities/:id/followup/log', async ({ user, params, body }) => fu.logActivity(estWrite(user), uuid(params.id), body));
route('POST', '/api/opportunities/:id/followup/classify', async ({ user, params, body }) => fu.classify(estWrite(user), uuid(params.id), body));
route('POST', '/api/opportunities/:id/followup/pause', async ({ user, params, body }) => { await fu.pause(estWrite(user), uuid(params.id), body); return { ok: true }; });
route('POST', '/api/opportunities/:id/followup/resume', async ({ user, params, body }) => { await fu.resume(estWrite(user), uuid(params.id), body); return { ok: true }; });
route('POST', '/api/projects/:id/contract', async ({ req, user, params }) => { manage(user); return ct.readContract(user, uuid(params.id), await readRaw(req), fname(req), q1(req, 'kind') || 'Contract'); }, { raw: true });
route('GET', '/api/projects/:id/contract', async ({ user, params }) => { await auth.requireProject(user, uuid(params.id)); return ct.getContract(params.id); });
route('PUT', '/api/contract-runs/:id', async ({ user, params, body }) => { manage(user); await ct.updateRun(uuid(params.id), body); return { ok: true }; });
route('POST', '/api/contract-runs/:id/lines', async ({ user, params, body }) => { manage(user); return ct.addLine(uuid(params.id), body); });
route('POST', '/api/contract-runs/:id/apply', async ({ user, params }) => { manage(user); return ct.applyRun(user, uuid(params.id)); });
route('DELETE', '/api/contract-runs/:id', async ({ user, params }) => { manage(user); await ct.discardRun(uuid(params.id)); return { ok: true }; });
route('PUT', '/api/contract-lines/:id', async ({ user, params, body }) => { manage(user); await ct.updateLine(uuid(params.id), body); return { ok: true }; });
route('DELETE', '/api/contract-lines/:id', async ({ user, params }) => { manage(user); await ct.deleteLine(uuid(params.id)); return { ok: true }; });
route('POST', '/api/projects/:id/invoice-schedule', async ({ user, params, body }) => { manage(user); return ct.addSchedule(uuid(params.id), body); });
route('PUT', '/api/invoice-schedule/:id', async ({ user, params, body }) => { manage(user); await ct.updateSchedule(uuid(params.id), body); return { ok: true }; });
route('DELETE', '/api/invoice-schedule/:id', async ({ user, params }) => { manage(user); await ct.deleteSchedule(uuid(params.id)); return { ok: true }; });
route('GET', '/api/projects/:id/origin', async ({ user, params }) => { await auth.requireProject(user, uuid(params.id)); return es.projectOrigin(params.id); });
route('POST', '/api/opportunities/:id/takeoff', async ({ req, user, params }) => tk.runTakeoff(estWrite(user), uuid(params.id), await readRaw(req), fname(req)), { raw: true });
route('GET', '/api/opportunities/:id/takeoff', async ({ user, params }) => { estRead(user); return tk.getTakeoff(uuid(params.id)); });
route('POST', '/api/takeoff/:id/items', async ({ user, params, body }) => tk.addItem(uuid(params.id), (estWrite(user), body)));
route('PUT', '/api/takeoff/items/:id', async ({ user, params, body }) => { estWrite(user); await tk.updateItem(uuid(params.id), body); return { ok: true }; });
route('DELETE', '/api/takeoff/items/:id', async ({ user, params }) => { estWrite(user); await tk.deleteItem(uuid(params.id)); return { ok: true }; });
route('POST', '/api/takeoff/:id/verify', async ({ user, params }) => { estWrite(user); await tk.verifyRun(uuid(params.id)); return { ok: true }; });
route('POST', '/api/takeoff/:id/apply', async ({ user, params }) => tk.applyRun(estWrite(user), uuid(params.id)));
// Bid inbox feed: Gmail connection (owner only), refresh (estimators and up), settings and city tiers
route('GET', '/api/bids/status', async ({ user }) => { estRead(user); return bd.refreshStatus(); });
route('POST', '/api/bids/refresh', async ({ user }) => {
  estWrite(user);
  if (!(await bd.refreshStatus()).connected) throw new HttpError(409, 'Gmail is not connected yet. The owner connects it in Admin.');
  if (!ai.aiConnected()) throw new HttpError(503, 'AI reading is not connected yet, so emails cannot be read. Add the Anthropic API key on the server.');
  const r = await bd.runRefresh({ trigger: 'Manual', userId: user.id }); return { id: r.id };
});
route('PUT', '/api/bids/settings', async ({ user, body }) => { auth.requireRole(user, auth.APPROVERS); await bd.saveBidSettings(body); return { ok: true }; });
route('GET', '/api/gmail/connect', async ({ user }) => { auth.requireRole(user, auth.SUPER); return { url: bd.connectUrl(user) }; });
route('GET', '/api/gmail/callback', async ({ req, res, user }) => {
  auth.requireRole(user, auth.SUPER); const p = new URL(req.url, 'http://x').searchParams;
  if (p.get('error')) throw bad('Google did not allow the connection (' + p.get('error') + ').');
  await bd.finishConnect(p.get('code'), p.get('state')); res.writeHead(302, { location: '/#/admin/connections', 'cache-control': 'no-store' }); res.end(); return 'sent';
});
route('DELETE', '/api/gmail', async ({ user }) => { auth.requireRole(user, auth.SUPER); await bd.disconnect(); return { ok: true }; });
route('GET', '/api/regions', async ({ user }) => { estRead(user); return bd.listRegions(); });
route('PUT', '/api/regions', async ({ user, body }) => { auth.requireRole(user, auth.APPROVERS); await bd.saveRegion(body); return { ok: true }; });
route('DELETE', '/api/regions/:city', async ({ user, params }) => { auth.requireRole(user, auth.APPROVERS); await bd.deleteRegion(decodeURIComponent(params.city)); return { ok: true }; });
route('GET', '/api/estimating/insights', async ({ user }) => { estRead(user); return es.insights(); });
route('PUT', '/api/settings/estimating', async ({ user, body }) => { auth.requireRole(user, auth.APPROVERS); await es.saveSettings(body); return { ok: true }; });
route('GET', '/api/estimating/connection', async ({ user }) => { estRead(user); return { buildingConnected: { connected: !!(process.env.APS_CLIENT_ID && process.env.APS_CLIENT_SECRET), note: 'Live BuildingConnected sync needs an Autodesk Platform Services app (client ID and secret) and your approval. Until then, export your bid invitations as CSV and import them here.' } }; });

// Messaging and to-dos (office staff only; field clock users never reach these)
const staff = (u) => { auth.requireRole(u, ms.STAFF); return u; };
route('GET', '/api/team/directory', async ({ user }) => { staff(user); return ms.directory(); });
route('GET', '/api/search/records', async ({ req, user }) => { staff(user); return ms.searchRecords(q1(req, 'kind'), q1(req, 'q')); });
route('GET', '/api/threads', async ({ user }) => ms.listThreads(staff(user).id));
route('POST', '/api/threads', async ({ user, body }) => ms.createThread(staff(user), body));
route('GET', '/api/threads/:id', async ({ user, params }) => ms.getThread(staff(user), uuid(params.id)));
route('POST', '/api/threads/:id/messages', async ({ user, params, body }) => ms.reply(staff(user), uuid(params.id), body));
route('POST', '/api/threads/:id/members', async ({ user, params, body }) => { await ms.addMember(staff(user), uuid(params.id), body.userId); return { ok: true }; });
route('GET', '/api/messages/badge', async ({ user }) => ms.badge(staff(user)));
route('POST', '/api/todos/seen', async ({ user }) => { await ms.markSeen(staff(user)); return { ok: true }; });
route('GET', '/api/todos/:id/comments', async ({ user, params }) => ms.listComments(staff(user), uuid(params.id)));
route('POST', '/api/todos/:id/comments', async ({ user, params, body }) => ms.addComment(staff(user), uuid(params.id), body));
route('POST', '/api/todos/:id/send', async ({ user, params, body }) => ms.sendAsMessage(staff(user), uuid(params.id), body));
route('GET', '/api/todos', async ({ req, user }) => ms.listTodos(staff(user), { assignedTo: q1(req, 'assignedTo'), status: q1(req, 'status'), threadId: q1(req, 'threadId'), linkedKind: q1(req, 'kind'), linkedId: q1(req, 'id'), all: q1(req, 'all') === '1' }));
route('POST', '/api/todos', async ({ user, body }) => ms.createTodo(staff(user), body));
route('PUT', '/api/todos/:id', async ({ user, params, body }) => { await ms.updateTodo(staff(user), uuid(params.id), body); return { ok: true }; });
route('DELETE', '/api/todos/:id', async ({ user, params }) => { await ms.deleteTodo(staff(user), uuid(params.id)); return { ok: true }; });
route('GET', '/api/records/:kind/:id/attached', async ({ user, params }) => { staff(user); return ms.forRecord(params.kind, uuid(params.id)); });

// Documents, receipts (AI), overhead
route('GET', '/api/trade-options', async ({ user }) => { manage(user); const ps = await q('SELECT id, name FROM projects WHERE active ORDER BY name'); const ts = ps.length ? await q('SELECT pt.id, pt.project_id, t.name FROM project_trades pt JOIN trades t ON t.id=pt.trade_id WHERE pt.project_id = ANY($1::uuid[]) ORDER BY t.sort, t.name', [ps.map((p) => p.id)]) : []; return ps.map((p) => ({ ...p, trades: ts.filter((t) => t.project_id === p.id).map((t) => ({ id: t.id, name: t.name })) })); });
const q1 = (req, k) => new URL(req.url, 'http://x').searchParams.get(k) || undefined;
const fname = (req) => decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
route('POST', '/api/documents/upload', async ({ req, user }) => { manage(user); return dc.uploadDocument(user, { category: q1(req, 'category'), name: q1(req, 'name'), filename: fname(req), projectId: q1(req, 'projectId'), subcontractorId: q1(req, 'subcontractorId'), expiresOn: q1(req, 'expiresOn'), bytes: await readRaw(req) }); }, { raw: true });
route('POST', '/api/documents', async ({ user, body }) => { manage(user); return dc.addLink(user, body); });
route('GET', '/api/documents', async ({ req, user }) => { const pid = q1(req, 'projectId'); if (pid) await auth.requireProject(user, uuid(pid)); else manage(user); return dc.listDocuments({ projectId: pid, category: q1(req, 'category') }); });
route('GET', '/api/documents/:id/file', async ({ res, user, params }) => {
  const d = await dc.getFile(uuid(params.id));
  if (d.category === 'Employee ID') auth.requireRole(user, auth.APPROVERS); else if (d.project_id) await auth.requireProject(user, d.project_id); else manage(user);
  const inline = /^(application\/pdf|image\/)/.test(d.mime);
  res.writeHead(200, { ...SEC, 'content-type': d.mime, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`, 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" });
  fs.createReadStream(d.file).pipe(res); return 'sent';
});
route('DELETE', '/api/documents/:id', async ({ user, params }) => { manage(user); await dc.deleteDocument(uuid(params.id)); return { ok: true }; });
route('POST', '/api/receipts/parse', async ({ req, user }) => { manage(user); return rc.parseUpload(user, await readRaw(req), fname(req)); }, { raw: true });
route('POST', '/api/receipts', async ({ user, body }) => { manage(user); return rc.createReceipt(user, body); });
route('GET', '/api/receipts', async ({ user }) => { manage(user); return rc.listReceipts(); });
route('GET', '/api/ai/usage', async ({ user }) => { manage(user); return { connected: ai.aiConnected(), ...(await ai.usageThisMonth()) }; });
route('PUT', '/api/settings/ai', async ({ user, body }) => { auth.requireRole(user, auth.SUPER); await aiu.saveSettings(body); return { ok: true }; });
route('GET', '/api/ai/report', async ({ req, user }) => { auth.requireRole(user, auth.SUPER); return aiu.report(q1(req, 'days')); });
route('GET', '/api/overhead', async ({ user }) => { auth.requireRole(user, auth.APPROVERS); return oh.overview(user); });
route('POST', '/api/overhead', async ({ user, body }) => { auth.requireRole(user, auth.SUPER); return oh.create(body); });
route('PUT', '/api/overhead/:id', async ({ user, params, body }) => { auth.requireRole(user, auth.SUPER); return oh.update(uuid(params.id), body); });
route('DELETE', '/api/overhead/:id', async ({ user, params }) => { auth.requireRole(user, auth.SUPER); await oh.remove(uuid(params.id)); return { ok: true }; });
route('PUT', '/api/settings/overhead', async ({ user, body }) => { auth.requireRole(user, auth.SUPER); await oh.saveBasis(body.basis); return { ok: true }; });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const SEC = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/clock') rel = '/clock.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, SEC); return res.end('Not found'); }
  res.writeHead(200, { ...SEC, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const hit = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!hit) throw new HttpError(404, 'Not found.');
    if (!hit.raw && req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json') && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined) throw new HttpError(415, 'Send JSON.');
    const m = url.pathname.match(hit.re);
    const params = Object.fromEntries(hit.names.map((n, i) => [n, m[i + 1]]));
    const user = acc.gate(await auth.userFromRequest(req), url.pathname, req.method);   // an area switched off is refused here; a lent area acts with the lent role
    const body = req.method === 'GET' || req.method === 'DELETE' || hit.raw ? {} : await readJson(req);
    const result = await hit.handler({ req, res, user, params, body });
    if (result !== 'sent') send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e.code === '22P02') return send(res, 400, { error: 'Invalid value.' }); // bad uuid/number format from Postgres
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  bootstrapOwner().then((r) => console.log(r.created ? `Created the owner login for ${r.email}. Remove ADMIN_PASSWORD from the host settings now.` : r.reason.startsWith('Set ') ? r.reason : 'Owner login already set up.')).catch((e) => console.error('bootstrap failed', e.message));
  server.listen(port, () => { console.log(`by Other Desk Platform on port ${port}`); bd.startScheduler(); setTimeout(() => folders.syncGcs(), 20000); setInterval(() => folders.syncGcs(), 3600000); setInterval(() => { qbo.status().then((st) => st.connected && st.connectedEnvironment === st.environment ? qbi.sync() : null).catch((e) => console.error('QuickBooks sync', e.message)); }, 3600000); setInterval(() => fu.closeDueCases().catch((e) => console.error('follow-up sweep', e.message)), 3600000); });
  const watch = () => cp.scan().then(() => cp.scanNtos()).then(() => cp.sendQueued()).catch((e) => console.error('compliance scan failed', e.message));
  setTimeout(watch, 15_000); setInterval(watch, 6 * 3600_000);
}

process.on('unhandledRejection', (e) => console.error('unhandled', e));
