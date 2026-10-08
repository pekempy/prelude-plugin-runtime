BEGIN;

SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM fluxer_kv
    WHERE table_name = 'user_connections'
      AND partition_key = :'partition_key'
      AND row_data ->> 'connection_type' = 'domain'
      AND lower(row_data ->> 'identifier') = lower(:'domain')
    LIMIT 1
  ) THEN 'true'
  ELSE 'false'
END AS existing_found
\gset

\if :apply
  \if :existing_found
    UPDATE fluxer_kv AS connection
    SET row_data = connection.row_data || jsonb_build_object(
          'name', :'domain'::text,
          'verified', true,
          'verified_at', CASE
            WHEN connection.row_data -> 'verified_at' IS NULL
              OR connection.row_data -> 'verified_at' = 'null'::jsonb
            THEN jsonb_build_object(
              '__fluxer_type', 'date',
              'value', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
            ELSE connection.row_data -> 'verified_at'
          END,
          'last_verified_at', jsonb_build_object(
            '__fluxer_type', 'date',
            'value', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        ),
        updated_at = now()
    WHERE connection.table_name = 'user_connections'
      AND connection.row_key = (
        SELECT row_key
        FROM fluxer_kv
        WHERE table_name = 'user_connections'
          AND partition_key = :'partition_key'
          AND row_data ->> 'connection_type' = 'domain'
          AND lower(row_data ->> 'identifier') = lower(:'domain')
        ORDER BY row_key
        LIMIT 1
      );
    \echo Encora connection refreshed.
  \else
    WITH row_values AS (
      SELECT
        count(*)::integer AS sort_order,
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso
      FROM fluxer_kv
      WHERE table_name = 'user_connections'
        AND partition_key = :'partition_key'
    )
    INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, expires_at, updated_at)
    SELECT
      'user_connections',
      :'partition_key',
      :'partition_key' || E'\x1f' || '"domain"' || E'\x1f' || to_json(:'connection_id'::text)::text,
      jsonb_build_object(
        'user_id', jsonb_build_object('__fluxer_type', 'bigint', 'value', :'user_id'::text),
        'connection_id', :'connection_id'::text,
        'connection_type', 'domain',
        'identifier', :'domain'::text,
        'name', :'domain'::text,
        'verified', true,
        'visibility_flags', 1,
        'sort_order', row_values.sort_order,
        'verification_token', '',
        'verified_at', jsonb_build_object('__fluxer_type', 'date', 'value', row_values.now_iso),
        'last_verified_at', jsonb_build_object('__fluxer_type', 'date', 'value', row_values.now_iso),
        'created_at', jsonb_build_object('__fluxer_type', 'date', 'value', row_values.now_iso),
        'version', 1
      ),
      NULL,
      now()
    FROM row_values
    ON CONFLICT (table_name, row_key)
    DO UPDATE SET
      partition_key = EXCLUDED.partition_key,
      row_data = EXCLUDED.row_data,
      expires_at = EXCLUDED.expires_at,
      updated_at = now();
    \echo Encora connection created.
  \endif

  UPDATE fluxer_kv
  SET row_data = row_data || jsonb_build_object(
        'custom_badge_url', 'https://encora.it/images/favicon.png',
        'custom_badge_link', 'https://' || :'domain'::text
      ),
      updated_at = now()
  WHERE table_name = 'users'
    AND row_key = :'partition_key';
  \echo Encora custom badge updated on user record.
\else
  \if :existing_found
    \echo Dry run: an Encora connection exists and would be refreshed.
  \else
    \echo Dry run: a verified Encora connection would be created.
  \endif
  \echo Dry run: user custom badge would be set to https://encora.it/images/favicon.png -> https://:domain.
\endif

\if :rollback
  ROLLBACK;
  \echo Test transaction rolled back.
\else
  COMMIT;
\endif
