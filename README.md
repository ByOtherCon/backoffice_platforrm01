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
- The Gmail feed reads the invitation emails. The plans are downloaded from the invitation's Files tab (Download All) and added with **Upload plans** on the opportunity: the zip streams to disk (up to 600 MB), is copied in the background to `01. DL` in SharePoint, and the app's own copy is then removed. If SharePoint is down the app keeps its copy and a note says so.
- The BuildingConnected API needs a paid Bid Board Pro subscription to read invitations, so it is not used.

## Passwords

- Anyone signed in can press **Password** (top bar) to change their own password. It asks for the current one and signs out their other devices.
- **Forgot password?** on the sign-in page emails a one-time link (valid 60 minutes, three requests an hour). The email is sent from the Gmail account connected in Admin. Gmail must have been connected with permission to send; if Admin shows a "cannot send yet" note, press Disconnect, then Connect Gmail again.
- The owner can edit their own name, title and phone in Admin → Users; the access level stays Super Admin.

## Contracts and work orders

On a project, the **Contract** tab takes the signed subcontract or work order (PDF or photo). The AI reads the contract number, date, total, retainage, payment terms and each scope line, and matches the lines to your trades. Nothing on the project changes until you review the lines (fix a price or trade, untick a line) and press **Apply to project**.

- Applying sets each trade's contract amount (adding trades the proposal did not have), sets the retainage, and attaches the file as the project's contract. Trades the contract does not mention are kept as they were and listed.
- A lower amount cannot go below what is already billed on that trade; the whole apply is refused.
- A **tentative invoice schedule** is drafted from what the contract states (deposit, milestones, final payment), "monthly progress billing" when that is how it bills, and a retainage release line. Rows can be edited, skipped or added. Invoiced rows are locked. QuickBooks invoices are matched to these rows later.
- Uploading a revised contract replaces the first one; invoiced schedule rows are kept.
- Contract reads show up in Admin's AI usage as "Contracts and work orders".

## QuickBooks invoices

Admin → QuickBooks. Connect once (Intuit developer app keys on Render, then **Connect QuickBooks**). **Sync from QuickBooks** (also automatic every hour and right after connecting) reads invoices and payments into a review list. Nothing reaches Job Costing until someone presses **Review and import**.

- A project is suggested from the contract code (C… or P…) in the invoice number, memo or customer, then from the customer/job name (for example `Sachse Construction:Mall at Millenia`), then from a customer already matched before. Unmatched invoices can be matched by hand or ignored.
- Each invoice line is matched to the project's trades (adjustable). One QuickBooks invoice that covers several trades becomes one billing row per trade. A negative "retainage" line becomes retainage held, split in proportion; with none, the project's default retainage applies. A box lets you override it.
- Payments already received come in with the invoice, split across its trade rows in proportion. Payments that arrive later on an imported invoice are added automatically.
- Imported invoices are never rewritten. If the total changes in QuickBooks afterwards the invoice is flagged **Changed** for a person to look at.
- The usual billing rules still apply: an invoice that would pass the trade's contract, or a payment above the invoice, is refused and nothing is saved.
- An invoice that exactly matches a tentative line of the contract's invoice schedule marks that line Invoiced.
- Sandbox keys (`QBO_ENVIRONMENT=sandbox`) read a test company. For real books use the production keys and remove that setting, then disconnect and connect again.

## Who can do what, and signing in

- **Users** are created in the app (Admin → Company → Users & access), not on Render. Render is only where the app runs.
- **Access:** each person's access level (role) gives default areas. In the user form the owner can choose areas by hand (Estimating, Job costing, Invoice matching, Costs and receipts, Compliance, Reports, Admin lists) and which dashboard cards that person sees. An area the role does not normally have lets that person work in it as an office assistant would; approving payments and owner settings are never included. The owner always has everything.
- **QuickBooks page:** anyone with the *Invoice matching* area gets a QuickBooks page in the menu (without Admin access) to review and import invoices.
- **Sign in with Google:** staff sign in with their @byother.net Google account (domain set by `GOOGLE_LOGIN_DOMAIN`, default byother.net). It uses the same Google app as Gmail (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). One more redirect address must be added to that app in the Google Cloud console; Admin → Connections → Sign in with Google shows it with a Copy button. A Google account without a Back Office login, or with a switched-off one, is refused. Passwords keep working as a backup.
