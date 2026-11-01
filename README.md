# byOther Project Desk

One system for By Other Construction: **Estimating** (bid invitations to awarded projects), **Job costing** (contracts, trades, billing, vendors, suppliers, labor, profit by trade/project/GC), and the **Time clock** for field crews. Node 22 + PostgreSQL, no framework.

## Run it
1. Create a Postgres database and set `DATABASE_URL`.
2. `node db/migrate.js` (applies every `db/NNN_*.sql` in order).
3. Create the Super Admin (you choose the password, 10+ characters):
   `ADMIN_EMAIL=you@byother.net ADMIN_PASSWORD='...' node --experimental-strip-types scripts/seed.js`
4. Optional, creates Juliana and Silvia with one-time passwords printed once: `node --experimental-strip-types scripts/seed-team.js`
5. Start: `PORT=3000 node --experimental-strip-types server/index.js`  (office app at `/`, field time clock at `/clock`)
6. Tests (use a throwaway database; the suite wipes it): `npm test`

## Settings (environment variables)
| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection (required) |
| `NODE_ENV=production` | Marks session cookies Secure (serve over HTTPS) |
| `UPLOAD_DIR` | Where uploaded documents are stored (default `./uploads`). Back this folder up. |
| `ANTHROPIC_API_KEY` | Turns on AI reading of receipts, invoices and plans. Optional `ANTHROPIC_MODEL`. Without it everything works by hand. |
| `SECRET_KEY` | Encrypts the stored Google login. Render creates it for you. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google app that lets the platform read the BuildingConnected emails (read-only). See "Bid inbox from Gmail". |
| `PUBLIC_URL` | The site's own address. Render supplies it automatically; set it only on another host. |
| `SMTP_URL`, `EMAIL_FROM` | Sends vendor insurance-request emails. Without it they wait in the outbox on the Compliance page. |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Reserved for a future live BuildingConnected link (not built). Use CSV import today. |

## Putting it online (Render)
1. Put the project in a **private** GitHub repository (create a free GitHub account, make a private repo, push this folder).
2. At render.com, create an account, choose **New > Blueprint**, and pick the repo. It reads `render.yaml` and creates the web app, the database, and a 10 GB disk for uploaded files. (Plan names in `render.yaml` may need adjusting to what Render offers; it will tell you.)
3. When asked, fill in `ADMIN_EMAIL` (your email) and `ADMIN_PASSWORD` (a long password you choose). Leave `ANTHROPIC_API_KEY` blank until you have one.
4. Open the address Render gives you and sign in. Then **delete `ADMIN_PASSWORD`** from Render's settings (it is only used on first start).
5. The app creates its tables by itself on every start (`db/migrate.js` runs each update once). `/api/health` is the health check.
Back up: turn on Render's database backups (paid plans include daily backups) and its disk snapshots. Files also go to SharePoint once that connection is built.

## Bid inbox from Gmail
The Bid Opportunities list is filled from the BuildingConnected invitation emails in your Gmail, at **8:00 AM and 1:00 PM Eastern**, and whenever someone presses **Refresh now**.
1. **Anthropic API key** (reads the emails): create one at console.anthropic.com, then add it in Render > byother-desk > Environment as `ANTHROPIC_API_KEY`.
2. **Google app** at console.cloud.google.com: create a project, enable the **Gmail API**, set up the **OAuth consent screen** as **Internal** (works because byother.net is a Google Workspace; no Google review needed), add the scope `.../auth/gmail.readonly`, then create an **OAuth client ID** of type *Web application* with the authorized redirect URI `https://YOUR-SITE.onrender.com/api/gmail/callback`.
3. Put its **Client ID** and **Client secret** in Render > Environment as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and save (it redeploys).
4. Sign in as the owner, open **Admin > Bid invitations from Gmail**, press **Connect Gmail**, and sign in as the mailbox that receives the invitations.
5. Optional: enter the Gmail label (folder) name there to read only that label. Add your city tiers under **Region tiers**; cities not listed are Tier 3.
Rules: New leads decline one day past due, Reviewing leads two days; leads with no date stay open; search reaches every lead seen in the last 30 days, declined ones included; Reviewing leads also show in the Proposal Tracker; accepted work leaves the inbox. A refresh never accepts, declines or changes anything an estimator has done.

## Microsoft 365 setup (for the SharePoint/OneDrive connection)
Microsoft 365 Business Basic, three users (you, Juliana, Silvia) on byother.net, and one SharePoint team site named "ByOther". Verifying the domain adds a DNS record and does not change where email is delivered.

## Who can do what
Super Admin (owner only) · Sub Admin (can approve vendor payments, change pay rules) · Exec Assistant (enters records and money, cannot approve) · Estimator (estimating only) · Project Manager (assigned projects, read mostly) · field crew (time clock PIN only).

## Layout
- `src/lib/` pure rules, each with tests: `costing`, `payroll`, `compliance`, `estimating`, `overhead`, `forecast`, `split`
- `server/` the API (one file per area) · `public/` the screens · `db/` migrations · `test/` ~135 tests
