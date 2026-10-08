BEGIN;

SELECT
  count(DISTINCT c.partition_key) AS total_encora_connections,
  count(DISTINCT CASE WHEN (u.row_data ? 'custom_badge_url') THEN c.partition_key END) AS already_has_badge,
  count(DISTINCT CASE WHEN NOT (u.row_data ? 'custom_badge_url') OR u.row_data->>'custom_badge_url' IS NULL THEN c.partition_key END) AS needing_backfill
FROM fluxer_kv c
LEFT JOIN fluxer_kv u ON u.table_name = 'users' AND u.row_key = c.partition_key
WHERE c.table_name = 'user_connections'
  AND c.row_data->>'connection_type' = 'domain'
  AND lower(c.row_data->>'identifier') LIKE '%encora%';

\if :apply
  WITH candidates AS (
    SELECT DISTINCT ON (c.partition_key)
      c.partition_key,
      c.row_data->>'identifier' AS identifier
    FROM fluxer_kv c
    WHERE c.table_name = 'user_connections'
      AND c.row_data->>'connection_type' = 'domain'
      AND lower(c.row_data->>'identifier') LIKE '%encora%'
    ORDER BY c.partition_key, c.updated_at DESC
  )
  UPDATE fluxer_kv u
  SET row_data = u.row_data || jsonb_build_object(
        'custom_badge_url', 'https://encora.it/images/favicon.png',
        'custom_badge_link', 'https://' || lower(candidates.identifier)
      ),
      updated_at = now()
  FROM candidates
  WHERE u.table_name = 'users'
    AND u.row_key = candidates.partition_key
    AND (
      NOT (u.row_data ? 'custom_badge_url')
      OR u.row_data->>'custom_badge_url' IS NULL
      OR NOT (u.row_data ? 'custom_badge_link')
      OR u.row_data->>'custom_badge_link' IS NULL
    );
  \echo Encora custom badges backfilled.
\else
  \echo Dry run: candidate users shown above would be updated.
\endif

\if :rollback
  ROLLBACK;
  \echo Test transaction rolled back.
\else
  COMMIT;
\endif
