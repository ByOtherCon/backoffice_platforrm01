// QuickBooks Online (invoices and expenses). This first piece only reports how the connection is set up; it shows the exact redirect
// address to register with Intuit, built from the site's own address so nobody has to type it.
import { baseUrl } from './bids.js';

export const settings = () => ({ clientId: process.env.QBO_CLIENT_ID, secret: process.env.QBO_CLIENT_SECRET, environment: process.env.QBO_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production' });
export const configured = () => { const s = settings(); return !!(s.clientId && s.secret); };
export const redirectUri = () => `${baseUrl()}/api/quickbooks/callback`;
export function status() {
  let redirect = null, problem = null;
  try { redirect = redirectUri(); } catch (e) { problem = e.message; }
  const s = settings();
  return { configured: configured(), connected: false, environment: s.environment, redirectUri: redirect, problem,
    needs: ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'].filter((k) => !process.env[k]) };
}
