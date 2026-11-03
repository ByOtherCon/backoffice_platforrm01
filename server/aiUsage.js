// Where the AI money goes: by person, by task, by day. Dollar amounts are estimates from prices the Super Admin enters
// (the Anthropic Console is the real bill); without prices the report shows tokens only.
import { q } from './db.js';
import { bad } from './http.js';

export const TASKS = { receipt: 'Receipts and invoices', bids: 'Gmail bid emails', proposal: 'Proposal PDFs', takeoff: 'Plan takeoff', bidpage: 'Pasted invitation pages' };
const r2 = (n) => Math.round(n * 100) / 100;
const settings = async () => { const v = (await q(`SELECT value FROM app_settings WHERE key='ai'`))[0]?.value ?? {}; return { monthlyTokenCap: Number(v.monthlyTokenCap ?? 2000000), inputPerM: v.inputPerM ?? null, outputPerM: v.outputPerM ?? null }; };
export async function saveSettings(b) {
  const v = { ...(await settings()) };
  if (b.monthlyTokenCap !== undefined) { const n = Number(b.monthlyTokenCap); if (!Number.isInteger(n) || n < 0 || n > 1e10) throw bad('Enter a whole number of tokens.'); v.monthlyTokenCap = n; }
  for (const k of ['inputPerM', 'outputPerM']) if (b[k] !== undefined) { if (b[k] === '' || b[k] === null) v[k] = null; else { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0 || n > 10000) throw bad('Enter the price in dollars per million tokens.'); v[k] = n; } }
  await q(`INSERT INTO app_settings(key,value) VALUES ('ai',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [v]);
}
const costOf = (st) => (i, o) => (st.inputPerM == null || st.outputPerM == null ? null : r2((Number(i) * st.inputPerM + Number(o) * st.outputPerM) / 1e6));
const WHO = `COALESCE(NULLIF(u.name,''), u.email, 'Automatic (scheduled)')`;
const DAY = `(a.created_at AT TIME ZONE 'America/New_York')::date`;

export async function report(daysIn) {
  const days = [7, 30, 90, 365].includes(Number(daysIn)) ? Number(daysIn) : 30, st = await settings(), cost = costOf(st), since = `a.created_at >= now() - interval '${days} days'`;
  const agg = (rows) => rows.map((r) => ({ ...r, calls: Number(r.calls), input: Number(r.input), output: Number(r.output), tokens: Number(r.input) + Number(r.output), cost: cost(r.input, r.output) }));
  const T = `COUNT(*) AS calls, COALESCE(SUM(a.input_tokens),0) AS input, COALESCE(SUM(a.output_tokens),0) AS output`;
  const [byUser, byTask, byDay, byMonth, matrix, recent, [tot], [mon]] = await Promise.all([
    q(`SELECT ${WHO} AS who, ${T} FROM ai_usage a LEFT JOIN app_users u ON u.id=a.user_id WHERE ${since} GROUP BY 1 ORDER BY SUM(COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)) DESC`),
    q(`SELECT a.kind, ${T} FROM ai_usage a WHERE ${since} GROUP BY 1 ORDER BY SUM(COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)) DESC`),
    q(`SELECT ${DAY}::text AS day, ${T} FROM ai_usage a WHERE ${since} GROUP BY 1 ORDER BY 1`),
    q(`SELECT to_char(date_trunc('month', a.created_at AT TIME ZONE 'America/New_York'),'YYYY-MM') AS month, ${T} FROM ai_usage a WHERE a.created_at >= date_trunc('month', now()) - interval '5 months' GROUP BY 1 ORDER BY 1`),
    q(`SELECT ${WHO} AS who, a.kind, ${T} FROM ai_usage a LEFT JOIN app_users u ON u.id=a.user_id WHERE ${since} GROUP BY 1,2 ORDER BY SUM(COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)) DESC`),
    q(`SELECT a.created_at, ${WHO} AS who, a.kind, a.label, a.model, COALESCE(a.input_tokens,0) AS input, COALESCE(a.output_tokens,0) AS output FROM ai_usage a LEFT JOIN app_users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 40`),
    q(`SELECT ${T} FROM ai_usage a WHERE ${since}`),
    q(`SELECT COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0)::bigint AS tokens FROM ai_usage WHERE created_at >= date_trunc('month', now())`)]);
  const total = agg([tot])[0], tasks = agg(byTask).map((t) => ({ ...t, task: TASKS[t.kind] || t.kind }));
  return { days, rates: { inputPerM: st.inputPerM, outputPerM: st.outputPerM }, priced: st.inputPerM != null && st.outputPerM != null,
    total: { ...total, avgTokensPerCall: total.calls ? Math.round(total.tokens / total.calls) : 0 }, month: { tokens: Number(mon.tokens), cap: st.monthlyTokenCap, pctOfCap: st.monthlyTokenCap ? Math.round((Number(mon.tokens) / st.monthlyTokenCap) * 1000) / 10 : null },
    byUser: agg(byUser), byTask: tasks, byDay: agg(byDay), byMonth: agg(byMonth), byUserTask: agg(matrix).map((r) => ({ ...r, task: TASKS[r.kind] || r.kind })),
    recent: recent.map((r) => ({ at: r.created_at, who: r.who, task: TASKS[r.kind] || r.kind, label: r.label, model: r.model, input: Number(r.input), output: Number(r.output), cost: cost(r.input, r.output) })) };
}
// For the Reports page (export, filter, group).
export async function rows() {
  const st = await settings(), cost = costOf(st);
  return (await q(`SELECT (a.created_at AT TIME ZONE 'America/New_York')::date AS day, ${WHO} AS who, a.kind, a.label, a.model, COALESCE(a.input_tokens,0) AS i, COALESCE(a.output_tokens,0) AS o FROM ai_usage a LEFT JOIN app_users u ON u.id=a.user_id ORDER BY a.created_at DESC`))
    .map((r) => ({ date: r.day, person: r.who, task: TASKS[r.kind] || r.kind, detail: r.label, model: r.model, inputTokens: Number(r.i), outputTokens: Number(r.o), totalTokens: Number(r.i) + Number(r.o), estCost: cost(r.i, r.o) }));
}
