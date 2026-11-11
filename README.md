# by Other Desk Platform

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
- **Sign in with Google:** staff sign in with their @byother.net Google account (domain set by `GOOGLE_LOGIN_DOMAIN`, default byother.net). It uses the same Google app as Gmail (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). One more redirect address must be added to that app in the Google Cloud console; Admin → Connections → Sign in with Google shows it with a Copy button. A Google account without a Desk Platform login, or with a switched-off one, is refused. Passwords keep working as a backup.

## Time clock

- The first screen asks **Office Platform** or **Time Clock**. The Time Clock (also reachable at `/clock`) is the field page: pick your name, enter your PIN, clock in to a project and trade. Employees and their PINs are set in Admin → Lists → Employees.
- **Inside the platform:** a login can be linked to an employee (Admin → Company → Users & access → *Time Clock (Link To An Employee)*). That person gets a **Time Clock** page in the menu with the same clock-in, clock-out and "forgot to clock" screens. Time clock access is separate from the access areas, and one employee can be linked to one login.
- Hours from either place post to the project's labor by project and trade, the same way.

## To-dos and alerts

To-dos default to today as the start date, have priority levels (Low, Normal, High, Urgent) and can be general (no attached record). Each to-do has a notes log that writes itself (who added, assigned, changed priority or due date, finished) plus comments from anyone who can open it, and can be sent to other people as a message. The number on the Messages tab counts unread messages plus to-dos that are new to you, due today or overdue.

## Dashboard

Everyone lands on the dashboard after signing in. It is a grid of widgets (like phone widgets): each card can be **Small, Medium, Large or Full Width** and shows **Compact, Standard or Full** detail. A card never gets narrower than its content needs (the Projects table widens as it shows more columns). **Edit Dashboard** lets each person drag or arrow cards into order, resize them, remove them, and add them back from the tray; it saves as you go and is personal. A person only gets cards for the areas they have (Admin → Company → Users & access), each job role starts with its own layout, and **Reset To My Job's Layout** returns to it. The **My To-Dos** and **Messages** cards can be moved and resized but never removed.

## Addresses
Every address in the app is street, city, state and ZIP in the same box, with a green check once it matches the address service (the U.S. Census geocoder). Projects are Florida only; vendors, subcontractors and GCs can be anywhere (and a vendor's address is optional). A changed address needs a fresh check; an unchanged, already-checked one is kept. Older one-line addresses were split into the four parts when this was added, and are marked unchecked until someone presses Verify. The box is `public/address.js`; the server side is `addressColumns` in `server/address.js`.

## New project from a document
In **Projects → New project**, upload a proposal or signed contract (PDF or photo), or choose one from SharePoint. The AI fills in the name, GC (matched to the GC list), client, address, retainage and each trade with its amount, and says what it was unsure of; nothing is saved until you press Create. The document is kept as the project's contract file (and copied to the project's SharePoint folder). On the project's **Contract** tab the file can be replaced or removed; the AI read-and-apply flow there is unchanged. Code: `server/projectDraft.js`.

## Change orders from a document
On a project's **Change Orders** tab, **From A Document** reads a change order PDF (uploaded or from SharePoint) into a draft: number, date, signed or not, and each line matched to a trade. You check it, then **Add To Trades** creates one change order per trade (a trade not yet on the project is brought onto it at a zero original amount). The file is kept on the project (03. Change Orders in SharePoint), tied to those change orders, and can be replaced or removed per change order; deleting the last change order that uses a file deletes the file. The billing rules still apply (an approved change order cannot take a trade below zero). Code: `server/changeOrderDoc.js`.

## The Projects page
A summary for a chosen year (active and inactive projects, contract value, billed, due now, projected profit, notices to owner), the alerts and deadlines that need someone (overdue and upcoming Notices to Owner, billing due now, pending change orders, projects with no contract file, starts within two weeks, invoices past their expected date), then the project list. The list is editable for the office: start date, Notice to Owner status (a sent notice asks for its date) and the Active tick. Code: `server/projectsHome.js`.

## QuickBooks costs
The **QuickBooks** page has three tabs: Invoices, Costs and Hidden. **Costs** reads bills, checks, expenses and card charges (from the same start date as invoices; it also runs hourly) and does not touch Job Costing until you press **Review And Import**: each line goes to a trade, the whole project, or a company overhead category, and becomes a vendor invoice (marked "QuickBooks"). Checks, expenses and card charges are recorded as paid on the date written; a bill is recorded unpaid and its payments made in QuickBooks are added automatically. Things that are not project costs (taxes, insurance, loans, payroll) can be **Hidden**, either one item or the whole vendor now and later; the **Hidden** tab is searchable and brings anything back. Importing also remembers the vendor and where its costs usually go. Subcontractor bills are deliberately not imported here (they go through the project's Costs tab so payment approvals and compliance checks apply). Refunds and credits are set aside. QuickBooks does not give outside apps the bank-feed list of transactions waiting for review, only what is already recorded. Code: `server/qbCosts.js`.

## Time clock: the field page and Time & Pay
- **Signing in.** Pick your name from the list and enter your PIN. Every employee has one from the day they are added: the last 4 digits of their phone number, or 0000 when there is no number (it follows the phone until the office chooses a PIN; Admin → Lists → Employees → PIN). Nobody sees anyone else's hours or pay. Without a name and PIN, the **My Week** tab only says to select a name and enter a PIN.
- **Clock tab.** Clock in to a project, or to **Other** with a jobsite name and where it is (that day counts toward the week's pay but has no project). Where the project has a map point, clock-in must be within 3 miles (the point is set from the project's checked address; the owner can redo it or change the radius on the project's Labor tab). Trades are chosen **at the end of the day**: pick the trades and the hours for each (the last trade takes the rest). The day ends with the injury question (unchecked means no injury before, during or when signing out) and notes.
- **A day left open overnight** must be finished first: they enter when they stopped and their trades; they cannot clock in or add a day until then.
- **My Week tab.** This week, last week and two weeks ago (Monday to Sunday), each with hours, overtime and pay. Today and yesterday can be changed by the employee; older days are sent to the office as a change request.
- **Time & Pay (office).** Weekly tally per person (days, hours, regular, overtime, and for the owner rate and pay), hours and cost by project and trade for the week or for all time (kept as long as the project exists), the week's days with Change / Delete / **Add A Day** for anyone, and the **Change Requests** the employees sent. No approval step is needed for hours. Pay and rates are shown to the owner only.
- **Excel / analysis.** *Export This Week* and *Export Everything* give one row per employee, day, site and trade with the Monday of its week (ready for pivot tables or analysis). The same data is the report source "Daily hours by employee, site and trade (for Excel)" in Reports, with filters, grouping and presets like Labor by week and Labor by project.
- Code: `server/timeclock.js`, `public/clock.js`, `public/clockui.js`, and `timePayView` in `public/app.js`.

## Subcontractor verification
- **Adding one (Admin → Lists → Subcontractors)** takes the company or person's name, their address (optional) and their documents: the **W-9** and a **certificate of insurance** (with its expiry date) or a **workers' comp exemption**. Each subcontractor also gets its own SharePoint folder: `ByOther / Subcontractors / <company or person>`, and every file uploaded is copied into it (a rename renames the folder; a SharePoint outage never loses the record, and the folder can be made afterwards).
- **Verified** means a W-9 is on file and insurance (a certificate that has not expired, or an exemption that has not expired) is on file. Nothing else. It updates by itself: when insurance expires the subcontractor becomes unverified, and when a new certificate is uploaded they are verified again. The address and what the W-9 says about it do not affect this (they only matter for the 1099 information, below).
- **Unverified subcontractors cannot be paid.** Any payment, request or approval for one stops with a message that says they are unverified and why, and the project's Costs tab marks them "Unverified: Cannot Pay".
- **Super Admin override:** in Admin → Lists → Subcontractors, an unverified subcontractor has a **Verify** button next to Edit and Archive (only the Super Admin sees it). It verifies them by hand so they can be paid; once verified, the button is gone. To take it back, the Super Admin opens Edit and presses **Remove The Override**.
- Code: `server/subVerify.js`, `server/compliance.js` (`assertCanPay`, `setVerifyOverride`).

## 1099 information (crew and subcontractors)
- **Employees (1099 crew)** now have a checked address (Admin → Lists → Employees) and a **W-9** upload, the same rules as subcontractors: the address must be verified, a W-9 must be on file, and the address on the W-9 must match (read by AI, or confirmed by a person with **The W-9 Shows This Address**). The Employees list shows **Ready / Not Ready** for the 1099, and notes when the name on the W-9 differs from the employee's name (the 1099 uses the W-9 name).
- **Employee W-9s are private.** They hold tax numbers, so they stay in the platform only (never copied to SharePoint), never appear in the document list, searches or reports, and only the owner and Sub Admin can open the file. The tax number itself is never read or stored by the platform; it stays on the W-9 file.
- **Compliance → 1099 Information** shows, for a chosen year, everyone paid as a 1099 with what they were paid (crew pay is shown to the owner only; subcontractor payments are what was recorded as paid), whether the information is complete, and what is missing. **Export For Excel** gives one row per payee and year with the W-9 name, address on file and readiness; the same data is the report "1099 payees by year" in Reports. Vendors that supply materials are not included.

## Billing matrix
Projects → a project → **Progress Billing** opens with the **Billing Matrix**: one row per trade with the original contract, each approved change order (grouped by CO number) and the contract total on the left; then one column per invoice (month, invoice number) with the amount billed to each trade, colored green (paid), yellow (partly paid), orange (unpaid, not due yet) or red (unpaid, past due); then billed to date, retainage held, received, left to invoice and owed to us now. A bottom row totals every column and shows each invoice's status (Paid / Owed / Overdue). The office can click an amount to open that invoice.

## Layout: full width, no scroll bars
Pages use the whole screen width. Tables wrap their column headings, tighten their spacing as the space shrinks, and the less important columns step aside on narrower windows (columns tagged `lo`, `lo2`, `lo3` in `public/app.js`; the thresholds are the `@container` rules at the end of `public/style.css`). A table only gets a scroll bar as a last resort, on very narrow screens. "Delete" and "Remove" buttons in tables show a trash-can icon (`public/ui.js`, any `small danger` button labelled Delete or Remove).

## Costs, GCs, lead documents and QuickBooks go-live
- **Costs & Payables.** The tab opens with **Cost Summary By Trade**: for every trade, the subcontract, what the subs invoiced, what was paid and what is still owed (invoiced or not), the same for vendors, labor, total cost and total still owed, plus a project-wide total. The Subcontractors table shows **Invoiced To Us**, **Paid**, **Owed On Invoices**, **Not Yet Invoiced** and **Total Still Owed**; each sub opens to its list of bills (add, pay, delete there).
- **Subcontractors** have a **Contact Person**. **Vendors** can have a **Website** with no address, a vendor invoice has a **Description**, and can be marked **Paid** when it is entered.
- **GCs remember their address and contact.** Saving a lead stores the GC's checked address and contact on the GC itself (Admin → Lists → GCs shows and edits them). Picking that GC again fills the form, and the saved address needs no new check (`rememberGc`, `knownGcs` in `server/estimating.js`, migration 031).
- **Lead documents stay with the job.** The lead's plans, proposal and submittals show on the project's Documents tab (**From The Lead**, with the SharePoint job-folder files), downloadable by anyone on the project; the lead shows the project's own documents once it is a project (managers only).
- **Past bid dates.** A lead added by hand can have a bid date that has already passed and is not auto-declined for it (`keep_past_due`, migration 032). Imported and emailed invitations keep the normal rule.
- **QuickBooks go-live.** Admin → Connections → QuickBooks card → **Go Live With Your Real Company** lists the steps (production keys at Intuit, Render environment, disconnect, connect), the exact values for Intuit's app form, and the public **/terms** and **/privacy** pages Intuit requires and has **Clear Test Data**, which removes everything read from the sandbox company (imported invoices, payments, costs, rows waiting for review) and nothing typed in by hand. It only runs for the owner, and only while QuickBooks is disconnected or connected to the sandbox (`server/qbReset.js`).
- **Test rows left after going live.** If the review list still holds rows read from the sandbox company, the go-live section shows **Remove Leftover Test Rows**: it removes what was read before the real company was connected (and anything imported from it); rows from the real company stay (`clearLeftover` in `server/qbReset.js`).
- **Imported invoices and retainage.** The import never adds retainage by itself: only a retainage line on the QuickBooks invoice, or an amount typed on the review screen, holds any back (`importInvoice` in `server/qbImport.js`).
- **One-time vendors.** A receipt or vendor invoice with a new vendor asks whether to **Save this vendor for future purchases** or treat it as a **One-time purchase**. A one-time vendor stays on its invoice but is left out of the vendor dropdowns. Admin → Vendors hides them behind **Show one-time vendors**, where **Save As Vendor** adds one to the list (`server/vendors.js`, migration 033).
- **Uploads are kept once, and kept with the project.** Every uploaded file is fingerprinted, and the same file is refused anywhere in the system (any project, receipt, lead or document type) with a message saying where it already is. Reading a contract, change order or plans a second time reuses the saved file. A project's **Documents** tab lists everything tied to it: its uploads, contract, change orders, client invoice and subcontractor bill files, the receipts and invoices on its costs, the plans read for it, and the W-9 and insurance of its subcontractors; lead files show under **From The Lead**. Files saved before this get their fingerprint when the server starts (`findDuplicate`, `saveFile`, `backfillHashes` in `server/documents.js`, migration 034).
- **Subcontractor documents are read as they are chosen.** In Admin → Subcontractors, picking a file reads it right away, one at a time (the other file boxes wait). A **W-9**: if its address matches the one entered it is checked; if nothing was entered it is filled in; if it differs, the W-9 address is filled in and you are told, with a button to go back to what you typed. An **insurance certificate or workers comp exemption**: the form sets the type, lists each coverage and its end date in small print under the dropdown (General Liability, Workers Comp, Automobile, Umbrella) and sets the expiration to the earliest of them. Each file is read once (the answer is kept by the file's fingerprint) and the coverages stay with the saved file (`server/vendorRead.js`, migration 035).
- **Forms do not vanish.** A form for data that already exists closes only with **Save**, **Cancel** or **Close**; a click outside does nothing. A form for something new (Add, New, Enter, Vendor invoice, Review receipt, Import) closes on a click outside, but asks first if anything was typed. Dragging a text selection out of a window no longer counts as an outside click.
