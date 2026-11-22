-- Tracking numbers on purchases: entered with a vendor invoice or receipt, or added later. The app asks the tracking service (EasyPost)
-- for the status every hour, and when a package is delivered (or runs into a problem) everyone on the project gets an alert.
CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,   -- a purchase not entered as an invoice yet: the project it is for
  tracking_number text NOT NULL,
  carrier text,                                  -- UPS, FedEx, USPS, DHL… as given or as worked out from the number
  description text,
  status text NOT NULL DEFAULT 'Not checked',    -- Pre-transit, In transit, Out for delivery, Delivered, Problem, …
  status_detail text,
  est_delivery date,
  delivered_at timestamptz,
  service_id text,                               -- the tracker at the tracking service
  public_url text,
  checked_at timestamptz,
  alerted text,                                  -- which alert was sent last ('Delivered', 'Problem'), so each goes once
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (supplier_invoice_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS shipments_invoice ON shipments(supplier_invoice_id);
CREATE INDEX IF NOT EXISTS shipments_project ON shipments(project_id);
CREATE INDEX IF NOT EXISTS shipments_open ON shipments(created_at) WHERE delivered_at IS NULL;
