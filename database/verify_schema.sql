-- =============================================================================
-- DOJCD Connect — schema check
-- =============================================================================
-- Compares the CURRENT database with the template. Read-only.
--   psql -d <dbname> -v ON_ERROR_STOP=1 -f database/verify_schema.sql
--
--   FAIL  (exit code 3) when a template table / column / rule is missing
--   INFO  lists tables that exist here but are NOT in the template — i.e.
--         tables someone created locally and never put in schema.sql.
--         The message includes the pg_dump command that captures them.
--
-- When you add a table to schema.sql, add its name to expected_tables below.
-- =============================================================================

CREATE TEMP TABLE expected_tables (t text PRIMARY KEY);
INSERT INTO expected_tables VALUES
    ('client_user'), ('device_catalog'), ('operational_user'), ('department'),
    ('application'), ('notification'), ('document'), ('approval'), ('order'),
    ('report'), ('contract'), ('delivery'), ('audit_log'), ('refresh_token'),
    ('password_reset_token'), ('login_attempt'), ('device_return'),
    ('approval_delegation'), ('department_budget'), ('storage_files');

-- Columns that older databases are most likely to be missing.
CREATE TEMP TABLE expected_columns (t text, c text);
INSERT INTO expected_columns VALUES
    ('approval',         'approval_stage'),
    ('operational_user', 'is_deleted'),
    ('operational_user', 'deleted_at'),
    ('operational_user', 'department_id'),
    ('operational_user', 'has_global_access'),
    ('operational_user', 'must_change_password'),
    ('operational_user', 'is_super_admin'),
    ('device_catalog',   'stock_quantity'),
    ('application',      'parent_application_id'),
    ('document',         'file_path'),
    ('report',           'file_path');

DO $$
DECLARE
    missing_tables text;
    missing_cols   text;
    extra_tables   text;
    extra_dump     text;
    problems       text[] := '{}';
    n_expected     int;
    n_present      int;
BEGIN
    SELECT count(*) INTO n_expected FROM expected_tables;

    SELECT count(*) INTO n_present
      FROM expected_tables e
     WHERE EXISTS (SELECT 1 FROM information_schema.tables s
                    WHERE s.table_schema = current_schema()
                      AND s.table_name = e.t AND s.table_type = 'BASE TABLE');

    SELECT string_agg(e.t, ', ' ORDER BY e.t) INTO missing_tables
      FROM expected_tables e
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables s
                        WHERE s.table_schema = current_schema()
                          AND s.table_name = e.t AND s.table_type = 'BASE TABLE');

    SELECT string_agg(c.t || '.' || c.c, ', ' ORDER BY c.t, c.c) INTO missing_cols
      FROM expected_columns c
     WHERE EXISTS (SELECT 1 FROM information_schema.tables s
                    WHERE s.table_schema = current_schema() AND s.table_name = c.t)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns k
                        WHERE k.table_schema = current_schema()
                          AND k.table_name = c.t AND k.column_name = c.c);

    IF missing_tables IS NOT NULL THEN
        problems := problems || format('missing tables: %s', missing_tables);
    END IF;
    IF missing_cols IS NOT NULL THEN
        problems := problems || format('missing columns: %s', missing_cols);
    END IF;

    -- Rules that changed over time: make sure this database has the new ones.
    IF to_regclass('client_user') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'client_user'::regclass
           AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%Deactivated%') THEN
        problems := problems || 'client_user.registration_status does not allow ''Deactivated'' (migration 007)'::text;
    END IF;
    IF to_regclass('application') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'application'::regclass
           AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%Pending_Finance%') THEN
        problems := problems || 'application.application_status does not allow ''Pending_Finance'' (migration 001)'::text;
    END IF;
    IF to_regclass('operational_user') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = 'operational_user'::regclass
           AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%Finance%') THEN
        problems := problems || 'operational_user.user_role does not allow ''Manager''/''Finance'' (migration 001)'::text;
    END IF;
    IF to_regclass('approval') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_index i
         WHERE i.indrelid = 'approval'::regclass AND i.indisunique AND NOT i.indisprimary
           AND i.indnatts = 1
           AND (SELECT attname FROM pg_attribute
                 WHERE attrelid = i.indrelid AND attnum = i.indkey[0]) = 'application_id') THEN
        problems := problems || 'approval.application_id is still UNIQUE — two-stage approval will fail (migration 001)'::text;
    END IF;

    -- Tables here that the template does not know about.
    SELECT string_agg(s.table_name, ', ' ORDER BY s.table_name),
           string_agg('-t ' || quote_ident(s.table_name), ' ' ORDER BY s.table_name)
      INTO extra_tables, extra_dump
      FROM information_schema.tables s
     WHERE s.table_schema = current_schema() AND s.table_type = 'BASE TABLE'
       AND s.table_name NOT IN (SELECT t FROM expected_tables);

    RAISE NOTICE 'Database "%": % of % template tables present.',
                 current_database(), n_present, n_expected;

    IF extra_tables IS NOT NULL THEN
        RAISE NOTICE 'INFO  tables NOT in the template (created locally?): %', extra_tables;
        RAISE NOTICE '      capture their DDL:  pg_dump -s -d % % > database/local_only_tables.sql',
                     current_database(), extra_dump;
    END IF;

    IF array_length(problems, 1) > 0 THEN
        RAISE EXCEPTION E'Schema check FAILED:\n  - %',
                        array_to_string(problems, E'\n  - ')
              USING HINT = 'Run: ./database/setup.sh   (it is safe on an existing database)';
    END IF;

    RAISE NOTICE 'OK    schema matches the template.';
END
$$;
