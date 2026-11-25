-- A subcontractor's W-9, insurance certificate and exemption belong to the subcontractor (ByOther / Subcontractors / <name>), never to a project.
UPDATE documents SET project_id = NULL WHERE category IN ('W-9', 'COI', 'Exemption') AND project_id IS NOT NULL;
