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
| `ANTHROPIC_API_KEY` | Turns on AI reading of receipts, invoices and plans. Optional `ANTHROPIC_MODEL`. If Anthropic says the key is "not scoped to a workspace", either create the key inside a workspace or set `ANTHROPIC_WORKSPACE_ID`. Without it everything works by hand. |
| `SECRET_KEY` | Encrypts the stored Google login. Render creates it for you. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google app that lets the platform read the BuildingConnected emails (read-only). See "Bid inbox from Gmail". |
| `PUBLIC_URL` | The site's own address. Render supplies it automatically; set it only on another host. |
| `SMTP_URL`, `EMAIL_FROM` | Sends vendor insurance-request emails. Without it they wait in the outbox on the Compliance page. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SITE_URL` | Shared project folders in SharePoint (Microsoft Graph, app-only; the app needs the Sites.ReadWrite.All application permission with admin consent). Optional `MS_LIBRARY` (default Documents) and `MS_ROOT_FOLDER` (default ByOther; set empty to start at the library root). |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | BuildingConnected through your Autodesk app (read-only `data:read`). In the Autodesk app add the callback `https://<your site>/api/autodesk/callback`, then Admin → BuildingConnected → Connect. |

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

## Estimating workflow (how an opportunity moves)
- **Bid Opportunities** lists New opportunities only (Gmail BuildingConnected invitations, CSV, or **+ Opportunity**). A New one is declined automatically a set number of days after its bid due date (default 2, changeable on the Insights tab) and the system writes that in its Notes. No due date means it never expires.
- **Reviewing** and **Accepted** move to the **Proposal Tracker** (statuses: Reviewing, Accepted, Started, Submitted, Decided Not To Submit). Accepting needs a due date and an estimator and assigns the proposal number (P + MMDD + sequence).
- **Submitting** needs the proposal PDF. It is read by AI (when `ANTHROPIC_API_KEY` is set), you check every trade and amount, and the PDF lands in the opportunity's file list (the "submittal folder"). Every bid version is kept.
- After submission: **Not Awarded** (needs a reason), **No Communication From GC**, or **Awarded — Create Project in JC**, which builds the project with a Bid History tab holding the lead, proposal and notes.
- **Follow Ups**: one case per submitted version, cadence 7 / 3 / 2 / 4 / 2 business days (shortened only as far as a known start date requires). Sending is manual; you log emails and calls.
- Every status change, edit, decline, upload and note is written to the opportunity's **Notes**.
- Addresses are checked against the U.S. Census geocoder (free). If that service is unreachable you can use the address as entered; it is then marked as a format check only.

## Shared folders (SharePoint)
- Layout: `ByOther / <year> / <GC> / <P11021_Project_City> / 01. DL, 02. Proposal, 03. Change Orders, 04. Documents, 05. Material & Equipment Specs`.
- Reviewing or Accepting an opportunity creates its folder (an existing GC or project folder is reused, never duplicated). Accepting renames a no-number folder to its P code. Awarding renames P to C and gives the project its contract code.
- Files uploaded in the app are also copied into the right numbered folder. A SharePoint problem never loses an upload: it is saved in the app and a note says it was not copied.
- Reference code: P + month + day + a running number (P11021 is the first accepted on Nov 2). On award the P becomes C (C11021) and project documents carry it.
- To work from File Explorer, press Sync on the library in SharePoint once on each PC; then "Open in File Explorer" downloads a shortcut that opens the synced folder.

## Bringing a BuildingConnected invitation in
- **Fill from BuildingConnected** (button at the top of the opportunity form): on the invitation page press Ctrl+A, Ctrl+C, paste it in the box, press Read it. Claude fills only empty fields from what the page states (project, GC, contact, due date and time, addresses, job start date); GC and project addresses are checked and show their green check. Trades are never filled.
- **Upload plans** (in the opportunity's file list): the zip (or PDF) from the invitation's Files tab. It streams to disk (up to 600 MB), is filed with the opportunity, copied in the background to `01. DL` in SharePoint, and the app's own copy is then removed. If SharePoint is down the app keeps its copy and a note says so.
- The BuildingConnected API needs a paid Bid Board Pro subscription to read invitations (Autodesk answers `BB_PRO_SUBSCRIPTION_REQUIRED` without it), so the Gmail feed plus these two buttons are used instead.
