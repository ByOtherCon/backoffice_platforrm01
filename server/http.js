export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (m) => new HttpError(400, m);
export async function readJson(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Request too large.'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON.'); }
}
export const send = (res, status, body, headers = {}) => {
  const json = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json);
};
export function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
// money: nonnegative (or any sign) with at most two decimals
export function money(v, label, { negative = false } = {}) {
  if (v === '' || v === null || v === undefined) throw bad(`${label} is required.`);
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw bad(`${label} must be a valid amount with at most two decimals.`);
  if (!negative && n < 0) throw bad(`${label} cannot be negative.`);
  return Math.round(n * 100) / 100;
}
export function text(v, label, { max = 500, required = true } = {}) {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} is too long.`);
  return s;
}
export function dateStr(v, label, required = false) {
  if (!v) { if (required) throw bad(`${label} is required.`); return null; }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${label} must be a valid date.`);
  return v;
}
export function httpsUrl(v, label) {
  const s = text(v, label, { max: 2000, required: false });
  if (!s) return null;
  let u; try { u = new URL(s); } catch { throw bad(`${label} must be a valid link.`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw bad(`${label} must be an https link.`);
  return s;
}

export async function readRaw(req, limit = 25 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, `File is too large (limit ${Math.round(limit / 1048576)} MB).`); chunks.push(c); }
  return Buffer.concat(chunks);
}
