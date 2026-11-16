-- Documents sent out for signature through DocuSign: who signs, where it stands, and the signed copy once everyone has signed.
CREATE TABLE IF NOT EXISTS esign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,          -- the PDF that was sent
  envelope_id text NOT NULL UNIQUE,                                       -- DocuSign's id
  status text NOT NULL,                                                   -- sent, delivered, completed, declined, voided
  signers jsonb NOT NULL DEFAULT '[]'::jsonb, cc_email text, subject text,
  sent_by uuid REFERENCES app_users(id) ON DELETE SET NULL, sent_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, signed_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  last_checked_at timestamptz, error text
);
CREATE INDEX IF NOT EXISTS esign_project ON esign_envelopes(project_id, sent_at DESC);
