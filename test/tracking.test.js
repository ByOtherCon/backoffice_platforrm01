import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../db/migrate.js';
process.env.DATABASE_URL ||= 'postgres://bo_test:bo_test_pw@localhost/byother_test';
delete process.env.EASYPOST_API_KEY;
const { pool, q } = await import('../server/db.js');
const { server } = await import('../server/index.js');
const { hashPassword } = await import('../server/auth.js');
const tk = await import('../server/tracking.js');

// ---- a stand-in for the tracking service: trackers it holds, and what each one says
const trackers = new Map(); let seq = 0, calls = [];
tk.setTrackingFetch(async (url, init = {}) => {
  const u = new URL(url); calls.push([init.method, u.pathname, init.headers.authorization]);
  if (init.method === 'POST' && u.pathname === '/v2/trackers') { const b = JSON.parse(init.body).tracker; const t = { id: 'trk_' + ++seq, tracking_code: b.tracking_code, carrier: b.carrier || 'UPS', status: 'in_transit', status_detail: 'arrived_at_facility', est_delivery_date: '2026-11-25T00:00:00Z', public_url: 'https://track.easypost.com/x' + seq, tracking_details: [] }; trackers.set(t.id, t); return { ok: true, status: 200, json: async () => t }; }
  const m = u.pathname.match(/^\/v2\/trackers\/(.+)$/); if (init.method === 'GET' && m && trackers.has(m[1])) return { ok: true, status: 200, json: async () => trackers.get(m[1]) };
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
});

let base, office, pm, pm2, pid, inv;
async function call(method, path, body, cookie) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (email) => (await call('POST', '/api/login', { email, password: 'correct horse battery' })).cookie;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await applyAll(pool);
  const h = await hashPassword('correct horse battery');
  for (const [e, r] of [['office@x.net', 'Sub Admin'], ['pm@x.net', 'Project Manager'], ['pm2@x.net', 'Project Manager']]) await q('INSERT INTO app_users(email,name,role,password_hash) VALUES ($1,$1,$2,$3)', [e, r, h]);
  await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  office = await login('office@x.net'); pm = await login('pm@x.net'); pm2 = await login('pm2@x.net');
  const [{ id: gc }] = await q(`INSERT INTO gcs(name) VALUES ('Diamond Contractors') RETURNING id`);
  [{ id: pid }] = await q(`INSERT INTO projects(name,gc_id,client,address,ref_code) VALUES ('Burlington Ocala',$1,'Burlington','1 Main St','C26001') RETURNING id`, [gc]);
  await q(`INSERT INTO project_members SELECT $1, id FROM app_users WHERE email='pm@x.net'`, [pid]);
  const [{ id: sup }] = await q(`INSERT INTO suppliers(name) VALUES ('Masonite') RETURNING id`);
  [{ id: inv }] = await q(`INSERT INTO supplier_invoices(supplier_id,reference,invoice_date,total,description) VALUES ($1,'INV-77','2026-11-20',1200,'Doors') RETURNING id`, [sup]);
  await q('INSERT INTO supplier_allocations(supplier_invoice_id,project_id,amount) VALUES ($1,$2,1200)', [inv, pid]);
});
after(async () => { server.close(); await pool.end(); });

test('the carrier is worked out from the number, with a link to its tracking page', () => {
  assert.deepEqual(['1Z999AA10123456784', '9400111899223197428490', '771234567890', 'EA123456789US', '1234567890', 'ABC'].map(tk.carrierOf), ['UPS', 'USPS', 'FedEx', 'USPS', 'DHL', null]);
  assert.equal(tk.carrierLink('UPS', '1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784'); assert.equal(tk.carrierLink(null, 'x'), null);
});

test('without the tracking service: numbers are kept with the carrier link, and the screen says alerts are off', async () => {
  const r = await call('POST', '/api/shipments', { supplierInvoiceId: inv, numbers: '1z999aa10123456784, 771234567890' }, office); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.connected, false);
  const d = (await call('GET', `/api/projects/${pid}/shipments`, null, pm)).body; assert.equal(d.connected, false);
  assert.deepEqual(d.shipments.map((s) => [s.number, s.carrier, s.status, s.vendor, s.reference, !!s.link]).sort(), [['1Z999AA10123456784', 'UPS', 'Not checked', 'Masonite', 'INV-77', true], ['771234567890', 'FedEx', 'Not checked', 'Masonite', 'INV-77', true]]);
  assert.equal(calls.length, 0);
  assert.equal((await call('POST', '/api/shipments', { supplierInvoiceId: inv, numbers: '1Z999AA10123456784' }, office)).body.ids.length, 1);   // the same number again is not added twice
  assert.equal((await q('SELECT count(*)::int AS n FROM shipments'))[0].n, 2);
  assert.equal((await call('POST', '/api/shipments', { supplierInvoiceId: inv, numbers: 'no!' }, office)).status, 400);
  assert.equal((await call('POST', '/api/shipments', { projectId: pid, numbers: '1Z999AA10123456799' }, pm2)).status, 403);   // a PM not on this job
  assert.equal((await call('GET', `/api/projects/${pid}/shipments`, null, pm2)).status, 403);
  assert.equal((await call('POST', `/api/shipments/${d.shipments[0].id}/check`, null, office)).status, 503);
  await q('DELETE FROM shipments');
});

test('with the tracking service: registered at once, checked every hour; delivered, ready for pickup or a problem alerts the project once', async () => {
  process.env.EASYPOST_API_KEY = 'EZTK_test';
  try {
    const r = await call('POST', '/api/shipments', { projectId: pid, numbers: '1Z999AA10123456784', description: 'Door hardware' }, pm); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.at(-1), ['POST', '/v2/trackers', 'Basic ' + Buffer.from('EZTK_test:').toString('base64')]);
    let s = (await call('GET', `/api/projects/${pid}/shipments`, null, office)).body.shipments[0];
    assert.deepEqual([s.status, s.detail, s.estDelivery, s.link], ['In transit', 'arrived at facility', '2026-11-25', 'https://track.easypost.com/x1']);
    await call('POST', '/api/shipments', { supplierInvoiceId: inv, numbers: '771234567890' }, office);
    // delivered: everyone on the job and the office get an alert that opens the project
    trackers.get('trk_1').status = 'delivered'; trackers.get('trk_1').tracking_details = [{ status: 'delivered', datetime: '2026-11-22T15:04:00Z' }];
    trackers.get('trk_2').status = 'available_for_pickup';
    assert.equal((await tk.checkAll()).checked, 2);
    const notes = await q(`SELECT u.email, n.title, n.body, n.link FROM notifications n JOIN app_users u ON u.id=n.user_id WHERE n.kind='Delivery' ORDER BY n.title, u.email`);
    assert.deepEqual(notes.filter((n) => /^Delivered/.test(n.title)).map((n) => n.email), ['office@x.net', 'pm@x.net']); assert.ok(!notes.some((n) => n.email === 'pm2@x.net'));
    const d = notes.find((n) => /^Delivered/.test(n.title)); assert.equal(d.title, 'Delivered: Door hardware for C26001 Burlington Ocala'); assert.equal(d.link, `#/projects/${pid}/costs`); assert.match(d.body, /^UPS 1Z999AA10123456784: Delivered, Nov 22/);
    assert.ok(notes.some((n) => n.title === 'Ready for pickup: Masonite #INV-77 Doors for C26001 Burlington Ocala'));
    await tk.checkAll(); assert.equal((await q(`SELECT count(*)::int AS n FROM notifications WHERE kind='Delivery'`))[0].n, notes.length);   // each alert once
    s = (await call('GET', `/supplier-invoices/${inv}/shipments`.replace(/^/, '/api'), null, office)).body.shipments[0]; assert.equal(s.status, 'Ready for pickup');
    const list = (await call('GET', `/api/projects/${pid}/shipments`, null, pm)).body.shipments; assert.equal(list.at(-1).status, 'Delivered');   // delivered ones last
    // the dashboard's Alerts & Deadlines lists them too, each one cleared on its own; the costs list knows each invoice's tracking state
    let home = (await call('GET', '/api/projects/home', null, pm)).body.alerts.filter((x) => x.kind === 'delivery');
    assert.deepEqual(home.map((x) => [x.severity, x.title]).sort(), [['info', 'Delivered: Door hardware · Burlington Ocala'], ['medium', 'Ready For Pickup: Masonite #INV-77 Doors · Burlington Ocala']]);
    assert.ok(home.every((x) => x.link === `#/projects/${pid}/costs`)); assert.match(home.find((x) => x.severity === 'info').detail, /^UPS 1Z999AA10123456784 · Nov 22/);
    assert.equal((await call('POST', '/api/projects/home/alerts/clear', { keys: [home.find((x) => x.severity === 'info').key] }, pm)).status, 200);
    home = (await call('GET', '/api/projects/home', null, pm)).body.alerts.filter((x) => x.kind === 'delivery'); assert.deepEqual(home.map((x) => x.severity), ['medium']);
    const costRow = (await call('GET', `/api/projects/${pid}/costs`, null, office)).body.suppliers.find((x) => x.invoiceId === inv); assert.deepEqual(costRow.shipments, { n: 1, delivered: 0 });
    trackers.get('trk_2').status = 'return_to_sender'; const c = (await call('POST', `/api/shipments/${s.id}/check`, null, pm)).body; assert.equal(c.status, 'Problem: returning to sender');
    assert.ok((await q(`SELECT 1 FROM notifications WHERE title LIKE 'Delivery problem: Masonite #INV-77%'`)).length);
    const ed = await call('PUT', `/api/shipments/${s.id}`, { number: '1Z999AA10123456799', description: 'Hinges' }, pm); assert.equal(ed.status, 200, JSON.stringify(ed.body));   // a corrected number starts tracking again
    const s2 = (await call('GET', `/api/supplier-invoices/${inv}/shipments`, null, office)).body.shipments.find((x) => x.id === s.id); assert.deepEqual([s2.number, s2.carrier, s2.description, s2.status], ['1Z999AA10123456799', 'UPS', 'Hinges', 'In transit']);
    assert.equal((await call('PUT', `/api/shipments/${s.id}`, { number: 'x' }, pm)).status, 400);
    assert.equal((await call('DELETE', `/api/shipments/${s.id}`, null, pm2)).status, 403); assert.equal((await call('DELETE', `/api/shipments/${s.id}`, null, pm)).status, 200);
  } finally { delete process.env.EASYPOST_API_KEY; }
});
