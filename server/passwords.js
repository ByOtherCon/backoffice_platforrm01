// Changing your own password, and the emailed reset link for people who forgot it.
import crypto from 'node:crypto';
import { q } from './db.js';
import { bad, HttpError } from './http.js';
import { hashPassword, verifyPassword, MIN_PASSWORD } from './auth.js';
import { sendMail, baseUrl } from './bids.js';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const RESET_MINUTES = 60, MAX_REQUESTS_PER_HOUR = 3;
const checkNew = (pw) => { if (String(pw || '').length < MIN_PASSWORD) throw bad(`Password must be at least ${MIN_PASSWORD} characters.`); return String(pw); };

// Signed-in person changes their own password. Their other sessions are signed out; this one stays.
export async function changeOwn(user, current, next) {
  if (!user?.id) throw new HttpError(403, 'Time-clock sign-ins use a PIN, not a password.');
  const [u] = await q('SELECT password_hash FROM app_users WHERE id=$1', [user.id]);
  if (!u || !(await verifyPassword(String(current || ''), u.password_hash))) throw bad('Your current password is not right.');
  const pw = checkNew(next); if (pw === String(current)) throw bad('Choose a password different from the current one.');
  await q('UPDATE app_users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword(pw)]);
  await q('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [user.id, sha(user.token)]);
  return { ok: true };
}

// Always answers the same way, so nobody can use this to find out which emails have accounts.
export async function requestReset(email) {
  email = String(email || '').trim().toLowerCase();
  const [u] = email ? await q('SELECT id,email,name FROM app_users WHERE email=$1 AND active', [email]) : [];
  if (u) {
    const [{ n }] = await q(`SELECT count(*)::int n FROM password_resets WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [u.id]);
    if (n < MAX_REQUESTS_PER_HOUR) {
      const token = crypto.randomBytes(32).toString('base64url');
      await q(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`, [u.id, sha(token), String(RESET_MINUTES)]);
      try {
        await sendMail({ to: u.email, subject: 'Reset your ByOther Back Office password',
          text: `Hello${u.name ? ' ' + u.name : ''},\n\nSomeone asked to reset the password for ${u.email}. To choose a new one, open this link within ${RESET_MINUTES} minutes:\n\n${baseUrl()}/?reset=${token}\n\nIf you did not ask for this, ignore this email. Your password stays the same.\n` });
      } catch (e) { console.error('Password-reset email could not be sent:', e.message); }
    }
  }
  return { ok: true, message: 'If that email belongs to an account, a reset link is on its way. It expires in 60 minutes.' };
}
export async function checkReset(token) {
  const [r] = await q(`SELECT u.email FROM password_resets p JOIN app_users u ON u.id=p.user_id WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>now() AND u.active`, [sha(String(token || ''))]);
  if (!r) throw bad('This reset link has expired or was already used. Ask for a new one.');
  return { email: r.email };
}
export async function finishReset(token, password) {
  const pw = checkNew(password);
  const [r] = await q(`UPDATE password_resets p SET used_at=now() FROM app_users u WHERE u.id=p.user_id AND p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>now() AND u.active RETURNING p.user_id`, [sha(String(token || ''))]);
  if (!r) throw bad('This reset link has expired or was already used. Ask for a new one.');
  await q('UPDATE app_users SET password_hash=$2 WHERE id=$1', [r.user_id, await hashPassword(pw)]);
  await q('DELETE FROM sessions WHERE user_id=$1', [r.user_id]);
  await q('DELETE FROM login_attempts WHERE email=(SELECT email FROM app_users WHERE id=$1)', [r.user_id]);
  return { ok: true };
}
