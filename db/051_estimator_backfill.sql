-- Leads someone has worked on but with no estimator: the person who last changed them becomes the estimator (from the lead's log).
UPDATE opportunities o SET estimator_id = n.user_id
FROM (SELECT DISTINCT ON (opportunity_id) opportunity_id, user_id FROM opportunity_notes n JOIN app_users u ON u.id=n.user_id AND u.active AND u.role IN ('Super Admin','Sub Admin','Estimator')
      WHERE n.user_id IS NOT NULL ORDER BY opportunity_id, n.created_at DESC) n
WHERE n.opportunity_id = o.id AND o.estimator_id IS NULL AND o.status NOT IN ('New','Declined');
