-- Paying a subcontractor with no invoice (cash, Zelle, a credit where no money moved...): the person explains why, and the payment still counts on the contract.
ALTER TABLE sub_invoices ADD COLUMN IF NOT EXISTS no_invoice boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS memo text;
ALTER TABLE sub_payments ADD COLUMN IF NOT EXISTS method text, ADD COLUMN IF NOT EXISTS memo text;
-- a payment request can be for a subcontract itself (no bill yet); the bill is made when it is paid
ALTER TABLE payment_requests ALTER COLUMN sub_invoice_id DROP NOT NULL;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS commitment_id uuid REFERENCES sub_commitments(id) ON DELETE CASCADE, ADD COLUMN IF NOT EXISTS method text, ADD COLUMN IF NOT EXISTS memo text;
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_target;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_target CHECK (sub_invoice_id IS NOT NULL OR commitment_id IS NOT NULL);
