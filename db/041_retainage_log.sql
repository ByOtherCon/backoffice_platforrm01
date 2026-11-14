-- Retainage is logged, never deducted. An invoice is what will be paid; the retainage the GC holds back is kept beside it and added on top
-- to get the work billed against the contract. The final invoice for the retainage is marked as such: it uses up what was logged.
--   is_retainage : this invoice bills retainage that was held back earlier (it is not new work)
--   net_basis    : the row is already in the new form (amount = invoice + retainage logged). Rows from before are corrected per project,
--                  after a person has seen the list (Progress Billing, Update Retainage).
ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS is_retainage boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS net_basis boolean NOT NULL DEFAULT false;
-- Every project was created with 10% filled in, whether or not the GC holds retainage, and the number did nothing. Now that it decides what is
-- logged, it is set to 0 wherever retainage was never used (no invoice with retainage, no contract applied with a retainage percent).
UPDATE projects p SET retainage_pct = 0 WHERE p.retainage_pct = 10
  AND NOT EXISTS (SELECT 1 FROM client_invoices ci WHERE ci.project_id = p.id AND ci.retainage_held > 0)
  AND NOT EXISTS (SELECT 1 FROM contract_runs r WHERE r.project_id = p.id AND r.status = 'Applied' AND r.retainage_pct IS NOT NULL AND r.retainage_pct > 0);
ALTER TABLE projects ALTER COLUMN retainage_pct SET DEFAULT 0;
