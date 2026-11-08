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
-- Only rows whose filter is a JSON object are cast (pg_input_is_valid needs PG16,
-- so pre-select candidates by shape in a CTE before any ::jsonb cast).
WITH candidates AS (
  SELECT id, filter::jsonb AS f
  FROM "Segment"
  WHERE origin = 'crm' AND filter ~ '^\s*\{.*\}\s*$' AND filter LIKE '%"lifecycle"%'
)
UPDATE "Segment" s SET filter = jsonb_set(
    c.f,
    '{lifecycle}',
    (SELECT COALESCE(jsonb_agg(
        CASE WHEN lower(v) IN ('lead','customer','churned','patient','blocked') THEN lower(v) ELSE v END
     ), '[]'::jsonb)
     FROM jsonb_array_elements_text(c.f -> 'lifecycle') v)
  )::text
FROM candidates c
WHERE s.id = c.id
  AND jsonb_typeof(c.f -> 'lifecycle') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(c.f -> 'lifecycle') v
    WHERE lower(v) IN ('lead','customer','churned','patient','blocked') AND v <> lower(v)
  );

COMMIT;
