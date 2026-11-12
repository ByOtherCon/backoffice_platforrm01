// One job, several GCs. The same project often arrives once for each GC that invited us, and we quote it once with the same prices.
// A bundle is ONE lead: the main lead keeps the proposal and the submission, and lists every GC we pitched. Any of those GCs can award it.
// The other rows stay in the database (nothing is deleted) but point at the main lead through merged_into and are hidden from every list.
import { q, tx } from './db.js';
import { HttpError, bad } from './http.js';
import * as R from '../src/lib/bidrules.ts';
import * as folders from './folders.js';

const OPEN = ['New', 'Reviewing', 'Accepted', 'Started', 'Submitted'];
const RANK = { Submitted: 5, Started: 4, Accepted: 3, Reviewing: 2, New: 1 };
const note = (t, id, user, body) => t(`INSERT INTO opportunity_notes(opportunity_id,user_id,kind,body) VALUES ($1,$2,'System',$3)`, [id, user?.id ?? null, body]);
const who = (u) => u?.name || u?.email || 'the system';

export const gcList = (o) => R.gcNames(o.gc_name, o.invitations);
const jobOf = (o) => ({ name: o.name, city: o.city, address: o.address, threadId: o.gmail_thread_id });
// the GC's own entry in the invitation list, built from the lead's contact fields
const ownInvite = (o) => ({ gc: o.gc_name, contactName: o.contact_name || '', email: o.contact_email || '', phone: o.contact_phone || '', link: o.invitation_link || '', threadId: o.gmail_thread_id || null, nda: false });
const additional = (primaryGc, invs) => invs.filter((x) => R.gcKey(x.gc) !== R.gcKey(primaryGc)).map((x) => x.gc).join('; ') || null;

async function submissionCounts(ids) {
  const rows = await q('SELECT opportunity_id, COUNT(*)::int AS n FROM submissions WHERE opportunity_id = ANY($1::uuid[]) AND voided_at IS NULL GROUP BY 1', [ids]);
  return new Map(rows.map((r) => [r.opportunity_id, r.n]));
}
const score = (o, subs) => (o.project_id ? 1000 : 0) + (subs.get(o.id) ? 500 : 0) + (o.proposal_id ? 100 : 0) + (RANK[o.status] || 0) * 10;

// Jobs that appear under more than one GC. Two leads are linked when they are the same job under different GCs.
export async function findDuplicates() {
  const rows = await q(`SELECT o.*, u.name AS estimator FROM opportunities o LEFT JOIN app_users u ON u.id=o.estimator_id WHERE o.merged_into IS NULL AND o.status = ANY($1::text[]) ORDER BY o.created_at`, [OPEN]);
  const subs = await submissionCounts(rows.map((r) => r.id)), parent = rows.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (R.gcKey(rows[i].gc_name) !== R.gcKey(rows[j].gc_name) && R.sameJob(jobOf(rows[i]), jobOf(rows[j]))) parent[find(j)] = find(i);
  const groups = new Map(); rows.forEach((r, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))).push(r));
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ranked = [...g].sort((a, b) => score(b, subs) - score(a, subs)), primary = ranked[0];
    const own = g.filter((o) => subs.get(o.id) || o.proposal_id || o.project_id);
    const blocked = own.length > 1 ? `${own.length} of these already have their own proposal or submission, so they cannot be joined automatically. Open them and decide which one to keep.` : null;
    out.push({ primaryId: primary.id, blocked, leads: ranked.map((o) => ({ id: o.id, name: o.name, gc: o.gc_name, city: o.city, address: o.address, due: o.due_date, status: o.status, tier: o.tier, proposalId: o.proposal_id, submissions: subs.get(o.id) || 0, estimator: o.estimator })) });
  }
  return out;
}

// Leads that look like the one about to be entered, under another GC (asked before a new lead is saved).
export async function similarFor(spec) {
  const gc = String(spec.gc || '').trim(); if (!String(spec.name || '').trim()) return [];
  const rows = await q(`SELECT id, name, gc_name, city, address, due_date, status, invitations, gmail_thread_id FROM opportunities WHERE merged_into IS NULL AND status = ANY($1::text[])`, [OPEN]);
  const mine = { name: spec.name, city: spec.city || '', address: spec.address || '' };
  return rows.filter((o) => R.gcKey(o.gc_name) !== R.gcKey(gc) && !gcList(o).some((g) => R.gcKey(g) === R.gcKey(gc)) && R.sameJob(jobOf(o), mine))
    .map((o) => ({ id: o.id, name: o.name, gc: o.gc_name, gcs: gcList(o), city: o.city, due: o.due_date, status: o.status }));
}

// Joins `otherIds` into the main lead. Everything on the others (notes, files, messages, takeoffs, trades considered) moves to the main lead.
export async function mergeInto(user, primaryId, otherIds, { folderPerGc } = {}) {
  const others = [...new Set(otherIds || [])].filter((x) => x !== primaryId);
  if (!others.length) throw bad('Choose at least one more lead to join.');
  if (others.length > 8) throw bad('Join up to 8 leads at a time.');
  const ids = [primaryId, ...others].sort();
  const done = await tx(async (t) => {
    const rows = await t('SELECT * FROM opportunities WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    if (rows.length !== ids.length) throw new HttpError(404, 'Opportunity not found.');
    const by = new Map(rows.map((r) => [r.id, r])), main = by.get(primaryId);
    for (const o of rows) {
      if (o.merged_into) throw new HttpError(409, `${o.name} (${o.gc_name}) is already part of another bundle.`);
      if (!OPEN.includes(o.status)) throw new HttpError(409, `${o.name} (${o.gc_name}) is ${o.status}. Only open leads can be bundled.`);
      if (o.project_id) throw new HttpError(409, `${o.name} (${o.gc_name}) already has a project.`);
    }
    for (const id of others) {
      const o = by.get(id);
      const [{ n }] = await t('SELECT COUNT(*)::int AS n FROM submissions WHERE opportunity_id=$1', [id]);
      if (n || o.proposal_id) throw new HttpError(409, `${o.name} (${o.gc_name}) has its own proposal or submission. Keep that one as the main lead and join the others into it.`);
    }
    const invs = Array.isArray(main.invitations) ? [...main.invitations] : [];
    if (!invs.some((x) => R.gcKey(x.gc) === R.gcKey(main.gc_name))) invs.unshift(ownInvite(main));
    const joined = [];
    for (const id of others) {
      const o = by.get(id), list = Array.isArray(o.invitations) && o.invitations.length ? o.invitations : [ownInvite(o)];
      if (!list.some((x) => R.gcKey(x.gc) === R.gcKey(o.gc_name))) list.unshift(ownInvite(o));
      for (const inv of list) { const i = invs.findIndex((x) => R.gcKey(x.gc) === R.gcKey(inv.gc)); if (i < 0) invs.push(inv); else for (const k of ['contactName', 'email', 'phone', 'link', 'threadId']) if (inv[k] && !invs[i][k]) invs[i][k] = inv[k]; }
      joined.push(o);
      await t('UPDATE opportunity_notes SET opportunity_id=$1 WHERE opportunity_id=$2', [primaryId, id]);
      await t('UPDATE opportunity_files SET opportunity_id=$1 WHERE opportunity_id=$2', [primaryId, id]);
      await t('UPDATE communications SET opportunity_id=$1 WHERE opportunity_id=$2', [primaryId, id]);
      await t('UPDATE takeoff_runs SET opportunity_id=$1 WHERE opportunity_id=$2', [primaryId, id]);
      await t('INSERT INTO opportunity_considered_trades(opportunity_id,trade_id) SELECT $1, trade_id FROM opportunity_considered_trades WHERE opportunity_id=$2 ON CONFLICT DO NOTHING', [primaryId, id]);
      await t(`UPDATE record_links SET record_id=$1 WHERE kind='opportunity' AND record_id=$2 AND NOT EXISTS (SELECT 1 FROM record_links x WHERE x.owner_kind=record_links.owner_kind AND x.owner_id=record_links.owner_id AND x.kind='opportunity' AND x.record_id=$1)`, [primaryId, id]);
      await t('UPDATE opportunities SET merged_into=$2 WHERE id=$1', [id, primaryId]);
      await note(t, id, user, `Bundled by ${who(user)} into the lead for ${main.gc_name}. It is the same job, so it is now one lead with one proposal. Its notes and files moved there.`);
    }
    const set = { invitations: JSON.stringify(invs), additional_gcs: additional(main.gc_name, invs) };
    if (folderPerGc !== undefined) set.folder_per_gc = !!folderPerGc;
    // keep the earliest bid date among the bundle so nothing is missed
    const dues = rows.map((r) => r.due_date).filter(Boolean).sort(); if (dues.length && (!main.due_date || dues[0] < main.due_date) && ['New', 'Reviewing'].includes(main.status)) set.due_date = dues[0];
    const keys = Object.keys(set); await t(`UPDATE opportunities SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [primaryId, ...keys.map((k) => set[k])]);
    await note(t, primaryId, user, `Bundled by ${who(user)}: ${joined.map((o) => o.gc_name).join(', ')} invited us to the same job as ${main.gc_name}. It counts as one submission, and any of these GCs can award it. ${set.folder_per_gc ? 'A folder is kept under each GC.' : 'One folder is kept under the main GC.'}`);
    return { id: primaryId, gcs: gcList({ ...main, invitations: invs }), folderPerGc: set.folder_per_gc ?? main.folder_per_gc };
  });
  if (done.folderPerGc) await folders.tryEnsureGcFolders(primaryId);
  return done;
}

// Takes one GC back out of a bundle as its own lead again (only while that GC has not been given the award).
export async function unmerge(user, leadId) {
  return tx(async (t) => {
    const [o] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [leadId]); if (!o) throw new HttpError(404, 'Opportunity not found.');
    if (!o.merged_into) throw bad('This lead is not part of a bundle.');
    const [main] = await t('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [o.merged_into]); if (!main) throw new HttpError(404, 'The main lead was not found.');
    if (R.gcKey(main.gc_name) === R.gcKey(o.gc_name)) throw bad('This GC is the main lead for the bundle.');
    if (['Awarded', 'Not Awarded', 'No Communication'].includes(main.status)) throw new HttpError(409, 'The job already has a result, so it cannot be split again.');
    const invs = (Array.isArray(main.invitations) ? main.invitations : []).filter((x) => R.gcKey(x.gc) !== R.gcKey(o.gc_name));
    await t('UPDATE opportunities SET merged_into=NULL WHERE id=$1', [leadId]);
    await t('UPDATE opportunities SET invitations=$2, additional_gcs=$3 WHERE id=$1', [main.id, JSON.stringify(invs), additional(main.gc_name, invs)]);
    await t('DELETE FROM opportunity_folders WHERE opportunity_id=$1 AND lower(gc_name)=lower($2)', [main.id, o.gc_name]);
    await note(t, leadId, user, `Taken out of the bundle by ${who(user)}. It is a separate lead again; the notes and files stay with the main lead.`);
    await note(t, main.id, user, `${o.gc_name} was taken out of this bundle by ${who(user)} and is its own lead again.`);
    return { id: leadId, mainId: main.id };
  });
}

// Folder policy for a bundle: a folder under each GC (everything duplicated), or one folder under the main GC.
export async function setFolderPolicy(user, id, perGc) {
  const [o] = await tx(async (t) => {
    const rows = await t('SELECT id, folder_per_gc, invitations, gc_name, merged_into FROM opportunities WHERE id=$1 FOR UPDATE', [id]); if (!rows.length) throw new HttpError(404, 'Opportunity not found.');
    if (rows[0].merged_into) throw new HttpError(409, 'This lead is part of a bundle. Change it on the main lead.');
    await t('UPDATE opportunities SET folder_per_gc=$2 WHERE id=$1', [id, !!perGc]);
    await note(t, id, user, `${who(user)} chose ${perGc ? 'a separate folder under each GC, with everything duplicated' : 'one folder under the main GC'} for this job.`);
    return rows;
  });
  if (perGc && gcList(o).length > 1) await folders.tryEnsureGcFolders(id);
  return { ok: true };
}
