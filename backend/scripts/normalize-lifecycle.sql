-- Post-deploy, one-off and idempotent: lower-case the built-in contact lifecycle
-- values and the same values inside saved CRM segment filters.
-- Run ONLY after the SP-02 code is deployed. The old code matches lifecycle
-- case-sensitively, so running this earlier would empty saved segments.

BEGIN;

UPDATE "Contact" SET lifecycle = lower(lifecycle)
WHERE lower(lifecycle) IN ('lead','customer','churned','patient','blocked')
  AND lifecycle <> lower(lifecycle);

-- Segment.filter is JSON text such as {"lifecycle":["Lead","Customer"],...}.
-- Lower-case only the built-in values inside the "lifecycle" array.
UPDATE "Segment" s SET filter = jsonb_set(
    s.filter::jsonb,
    '{lifecycle}',
    (SELECT COALESCE(jsonb_agg(
        CASE WHEN lower(v) IN ('lead','customer','churned','patient','blocked') THEN lower(v) ELSE v END
     ), '[]'::jsonb)
     FROM jsonb_array_elements_text(s.filter::jsonb -> 'lifecycle') v)
  )::text
WHERE s.origin = 'crm'
  AND jsonb_typeof(s.filter::jsonb -> 'lifecycle') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(s.filter::jsonb -> 'lifecycle') v
    WHERE lower(v) IN ('lead','customer','churned','patient','blocked') AND v <> lower(v)
  );

COMMIT;
