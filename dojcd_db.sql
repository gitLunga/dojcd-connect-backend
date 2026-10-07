-- =============================================================================
-- DOJCD Connect -- dojcd_db.sql
-- THE database script: schema + reference data + self-check, in one file.
-- =============================================================================
-- Run it on ANY PostgreSQL database and that database ends up with the current
-- DOJCD schema, whatever state it was in:
--
--   empty database ............... creates everything (20 tables)
--   old 15-table database ........ adds what is missing
--   partly migrated database ..... fills in only what is missing
--   up-to-date database .......... changes nothing and takes no heavy locks
--
-- It never drops a table and never deletes a row. All schema work runs in ONE
-- transaction, so it applies completely or not at all. Two people running it at
-- the same time are serialised by a lock. It finishes with a read-only
-- self-check that compares the database with this file, table by table and
-- column by column, and lists anything that exists in YOUR database but is not
-- in this file (tables and columns someone created locally and never committed).
--
-- HOW TO RUN  (always with ON_ERROR_STOP, so the first error stops the run)
--   psql -d <dbname> -v ON_ERROR_STOP=1 -f dojcd_db.sql
--   ./database/setup.sh --create-db            (reads DB_* from .env)
--   pgAdmin / DataGrip / DBeaver: open this file and run it as a script.
-- It is plain SQL (no psql-only commands), so it works in every client.
-- Run it as the role that owns the database. PostgreSQL 15 and later do not let
-- other roles create tables in the public schema. It always works in the public
-- schema, whatever your search_path is. Do not wrap it in your own BEGIN ... ROLLBACK
-- as a dry run: it contains its own COMMIT.
--
-- SAMPLE DEVICES (optional, local testing only, never for production)
--   Off by default. To also load 8 sample devices, run this statement in the
--   same session BEFORE this file:   SET dojcd.with_samples = 'on'
--   With psql:  psql -d <dbname> -v ON_ERROR_STOP=1 -c "SET dojcd.with_samples = 'on'" -f dojcd_db.sql
--   With setup.sh:  ./database/setup.sh --samples
--
-- WHEN YOU CHANGE THE SCHEMA
--   Edit THIS file, then commit it. A change that exists only in your local
--   database does not exist for anyone else. That is how the databases drifted.
--     new table ........ add it in PART 1, add its name to expected_tables in
--                        PART 6, and add its columns to expected_columns
--     new column ....... add it to the table in PART 1 AND as an add_column line
--                        in PART 2 (so existing databases get it), AND to
--                        expected_columns in PART 6
--     new status list .. add it to checks in PART 3
--   The self-check tells you if you forgot one of these on a fresh database.
--
-- WHY ONE FILE
--   It replaces dojc_db.sql (15 tables, out of date), migrations/001..009,
--   migrations/all_migrations.sql, src/scripts/migrate-department-isolation.sql
--   and the "Sample Device Insert script". Those disagreed with each other and
--   could not be run in order on a fresh database: 005 failed (file_path already
--   existed), 008 failed (the department table was created only by a side
--   script), and operational_user.has_global_access, which login reads, existed
--   only in that side script. They are kept in git as history. Do not run them.
--
-- TABLES (20)
--    1 client_user         2 device_catalog      3 operational_user    4 department
--    5 application         6 notification        7 document            8 approval
--    9 order              10 report             11 contract           12 delivery
--   13 audit_log          14 refresh_token      15 password_reset_token
--   16 login_attempt      17 device_return      18 approval_delegation
--   19 department_budget  20 storage_files
-- =============================================================================

-- A previous run in this same session may have left these temporary objects.
DO $$
BEGIN
    IF to_regclass('pg_temp.dojcd_run_ok') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_run_ok; END IF;
    IF to_regclass('pg_temp.dojcd_checks') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_checks; END IF;
    IF to_regclass('pg_temp.dojcd_indexes') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_indexes; END IF;
    IF to_regclass('pg_temp.dojcd_cols') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_cols; END IF;
    IF to_regclass('pg_temp.dojcd_cons') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_cons; END IF;
END
$$;

BEGIN;

-- Quiet the already exists notices for the schema work below. SET LOCAL ends at
-- COMMIT, so the self-check at the bottom is fully visible.
SET LOCAL client_min_messages = warning;
-- Always build in the public schema. Fail fast instead of waiting forever if
-- another session holds a conflicting lock.
SET LOCAL search_path = public;SET LOCAL lock_timeout = '15s';

-- One run at a time per database. Without this, two people running the file at
-- the same moment can collide inside CREATE TABLE IF NOT EXISTS.
DO $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('dojcd_db.sql'));
END
$$;

-- Helper: add a column only if it is missing. Looks in the catalog first, so a
-- re-run on an up-to-date database takes no lock on the table at all.
CREATE OR REPLACE FUNCTION pg_temp.add_column(p_table text, p_column text, p_def text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    rel regclass := to_regclass(format('public.%I', p_table));
BEGIN
    IF rel IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = rel AND attname = p_column AND attnum > 0 AND NOT attisdropped) THEN
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', p_table, p_column, p_def);
    END IF;
END
$fn$;

-- Helper: create an index only if no relation of that name exists (no table lock on a no-op).
CREATE OR REPLACE FUNCTION pg_temp.ensure_index(p_name text, p_ddl text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    IF to_regclass(format('public.%I', p_name)) IS NULL THEN
        EXECUTE p_ddl;
    END IF;
END
$fn$;

-- Helper: make <column> obey one canonical, named CHECK rule.
--   * Already canonical (same name and same fingerprint)? Do nothing and take no lock.
--   * Existing rows hold values the rule does not allow? STOP with a message naming them.
--     Nothing has been changed yet and the whole run rolls back.
--   * Otherwise drop the single-column CHECKs on that column and add the canonical one.
--     Rules that involve several columns are never touched.
-- The fingerprint is stored as a comment on the constraint, and PART 6 verifies it.
CREATE OR REPLACE FUNCTION pg_temp.check_violations(p_table text, p_column text, p_expr text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
    bad text;
BEGIN
    IF to_regclass(format('public.%I', p_table)) IS NULL THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(format('public.%I', p_table))
                    AND attname = p_column AND attnum > 0 AND NOT attisdropped) THEN RETURN NULL; END IF;
    EXECUTE format(
        'SELECT string_agg(quote_literal(v) || '' (x'' || n || '')'', '', '' ORDER BY v) FROM (SELECT %I::text AS v, count(*) AS n FROM public.%I WHERE NOT (%s) GROUP BY 1) s',
        p_column, p_table, p_expr) INTO bad;
    RETURN bad;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.set_check(p_table text, p_column text, p_name text, p_expr text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    rel regclass := to_regclass(format('public.%I', p_table));
    att smallint;
    sig text := 'dojcd:' || md5(p_expr);
    c   record;
    bad text;
BEGIN
    IF rel IS NULL THEN RETURN; END IF;
    SELECT attnum INTO att FROM pg_attribute
     WHERE attrelid = rel AND attname = p_column AND attnum > 0 AND NOT attisdropped;
    IF att IS NULL THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conrelid = rel AND k.conname = p_name AND k.contype = 'c'
                  AND obj_description(k.oid, 'pg_constraint') = sig) THEN
        RETURN;
    END IF;
    EXECUTE format(
        'SELECT string_agg(DISTINCT quote_literal(%I::text), '', '') FROM public.%I WHERE NOT (%s)',
        p_column, p_table, p_expr) INTO bad;
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot apply the % rule on %: existing rows hold values this file does not allow: %',
                        p_column, p_table, bad
              USING HINT = 'Fix those rows, or add the value to the rule in PART 3 of dojcd_db.sql so every developer gets it.';
    END IF;
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = rel AND contype = 'c' AND conkey = ARRAY[att]
    LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', p_table, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', p_table, p_name, p_expr);
    EXECUTE format('COMMENT ON CONSTRAINT %I ON public.%I IS %L', p_name, p_table, sig);
END
$fn$;

-- =============================================================================
-- PART 1: TABLES  (final shape, in foreign-key dependency order)
--    Status and role lists that changed over time are NOT inline here: they live in
--    PART 3 (marked CHECK: PART 3), so there is a single list to maintain.
-- =============================================================================

-- 1. CLIENT_USER - Judges / Magistrates / Advocates who apply for devices.
CREATE TABLE IF NOT EXISTS client_user (
    client_user_id           SERIAL PRIMARY KEY,
    title                    VARCHAR(50),
    first_name               VARCHAR(255) NOT NULL,
    last_name                VARCHAR(255) NOT NULL,
    email                    VARCHAR(255) UNIQUE NOT NULL,
    phone_number             VARCHAR(50),
    region                   VARCHAR(100),
    persal_id                VARCHAR(50) UNIQUE,
    department_id            VARCHAR(50),          -- stores the department NAME
    user_type                VARCHAR(50) NOT NULL
        CHECK (user_type IN ('Advocate', 'Magistrate')),
    password_hash            VARCHAR(255) NOT NULL,
    cognito_id               VARCHAR(255) UNIQUE,
    network_provider         VARCHAR(50)
        CHECK (network_provider IN ('MTN', 'Vodacom', 'Cell_C', 'Telkom', 'Rain')),
    contract_duration_months INTEGER,
    contract_end_date        DATE,
    invoice_path             VARCHAR(255),
    registration_status      VARCHAR(50) NOT NULL DEFAULT 'Pending',  -- CHECK: PART 3
    verification_notes       TEXT,
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. DEVICE_CATALOG - devices and plans available for allocation.
CREATE TABLE IF NOT EXISTS device_catalog (
    device_id                SERIAL PRIMARY KEY,
    device_name              VARCHAR(255) NOT NULL,
    model                    VARCHAR(255),
    manufacturer             VARCHAR(255),
    plan_name                VARCHAR(255) NOT NULL,
    plan_details             TEXT,
    monthly_cost             NUMERIC(10, 2) NOT NULL,
    contract_duration_months INTEGER NOT NULL,
    status                   VARCHAR(50) NOT NULL
        CHECK (status IN ('active', 'inactive', 'discontinued')),
    stock_quantity           INTEGER CHECK (stock_quantity >= 0),  -- NULL = not tracked
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. OPERATIONAL_USER - internal staff (soft-deleted so approval history survives).
CREATE TABLE IF NOT EXISTS operational_user (
    op_user_id           SERIAL PRIMARY KEY,
    title                VARCHAR(20),
    first_name           VARCHAR(255) NOT NULL,
    last_name            VARCHAR(255) NOT NULL,
    email                VARCHAR(255) UNIQUE NOT NULL,
    user_role            VARCHAR(50) NOT NULL,                     -- CHECK: PART 3
    department_id        VARCHAR(50),                              -- stores the department NAME
    password_hash        VARCHAR(255) NOT NULL,
    cognito_id           VARCHAR(255) UNIQUE,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    is_super_admin       BOOLEAN NOT NULL DEFAULT false,
    has_global_access    BOOLEAN NOT NULL DEFAULT false,           -- cross-department visibility
    is_deleted           BOOLEAN NOT NULL DEFAULT false,
    deleted_at           TIMESTAMP WITH TIME ZONE,
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. DEPARTMENT - lookup table (previously only created by a side script).
CREATE TABLE IF NOT EXISTS department (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL UNIQUE,
    code       VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. APPLICATION - a request by a client for a device or plan.
CREATE TABLE IF NOT EXISTS application (
    application_id         SERIAL PRIMARY KEY,
    client_user_id         INTEGER NOT NULL,
    device_id              INTEGER NOT NULL,
    application_status     VARCHAR(50) NOT NULL,                   -- CHECK: PART 3
    submission_date        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_updated           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rejection_reason       TEXT,
    parent_application_id  INTEGER,                                -- re-submission lineage
    CONSTRAINT fk_application_client
        FOREIGN KEY (client_user_id) REFERENCES client_user (client_user_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_application_device
        FOREIGN KEY (device_id) REFERENCES device_catalog (device_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_application_parent
        FOREIGN KEY (parent_application_id) REFERENCES application (application_id)
        ON DELETE SET NULL
);

-- 6. NOTIFICATION - in-app notifications (polymorphic user_id + user_type).
CREATE TABLE IF NOT EXISTS notification (
    notification_id SERIAL PRIMARY KEY,
    user_id         INTEGER      NOT NULL,
    user_type       VARCHAR(20)  NOT NULL CHECK (user_type IN ('Client', 'Operational')),
    title           VARCHAR(255) NOT NULL,
    message         TEXT         NOT NULL,
    is_read         BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. DOCUMENT - supporting documents (application_id nullable: uploaded before applying).
CREATE TABLE IF NOT EXISTS document (
    document_id        SERIAL PRIMARY KEY,
    application_id     INTEGER,
    client_user_id     INTEGER NOT NULL,
    document_type      VARCHAR(50) NOT NULL
        CHECK (document_type IN ('Payslip', 'ID', 'Proof_of_Residence')),
    file_path          VARCHAR(255) NOT NULL,
    upload_date        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    document_status    VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (document_status IN ('Pending', 'Approved', 'Rejected', 'Verified')),
    verification_notes TEXT,
    verification_date  TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_document_application
        FOREIGN KEY (application_id) REFERENCES application (application_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_document_client
        FOREIGN KEY (client_user_id) REFERENCES client_user (client_user_id)
        ON DELETE RESTRICT
);

-- 8. APPROVAL - one row per stage per application (manager row + finance row).
--    application_id is deliberately NOT unique.
CREATE TABLE IF NOT EXISTS approval (
    approval_id         SERIAL PRIMARY KEY,
    application_id      INTEGER     NOT NULL,
    approver_op_user_id INTEGER     NOT NULL,
    approval_stage      VARCHAR(20),                               -- CHECK: PART 3
    approval_status     VARCHAR(50) NOT NULL
        CHECK (approval_status IN ('Approved', 'Rejected')),
    approval_date       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes               TEXT,
    CONSTRAINT fk_approval_application
        FOREIGN KEY (application_id) REFERENCES application (application_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_approval_approver
        FOREIGN KEY (approver_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 9. ORDER ("order" is a reserved word, so it is always quoted). 1:1 with application.
CREATE TABLE IF NOT EXISTS "order" (
    order_id             SERIAL PRIMARY KEY,
    application_id       INTEGER UNIQUE NOT NULL,
    mtn_staff_op_user_id INTEGER NOT NULL,
    order_status         VARCHAR(50) NOT NULL
        CHECK (order_status IN ('Processing', 'Dispatched', 'Delivered', 'Cancelled')),
    order_date           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    warehouse_ref        VARCHAR(255),
    notes                TEXT,
    CONSTRAINT fk_order_application
        FOREIGN KEY (application_id) REFERENCES application (application_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_order_mtn_staff
        FOREIGN KEY (mtn_staff_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 10. REPORT - generated report metadata.
CREATE TABLE IF NOT EXISTS report (
    report_id        SERIAL PRIMARY KEY,
    report_name      VARCHAR(255) NOT NULL,
    generated_date   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    file_path        VARCHAR(255) NOT NULL,
    admin_op_user_id INTEGER NOT NULL,
    CONSTRAINT fk_report_admin
        FOREIGN KEY (admin_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 11. CONTRACT - activated on delivery (IMEI, SIM, MTN reference). 1:1 with order.
CREATE TABLE IF NOT EXISTS contract (
    contract_id      SERIAL PRIMARY KEY,
    order_id         INTEGER UNIQUE NOT NULL,
    device_id        INTEGER NOT NULL,
    imei             VARCHAR(50) UNIQUE NOT NULL,
    sim_number       VARCHAR(50) UNIQUE NOT NULL,
    billing_plan_ref VARCHAR(255),
    activation_date  TIMESTAMP WITH TIME ZONE,
    mtn_contract_ref VARCHAR(255) UNIQUE,
    CONSTRAINT fk_contract_order
        FOREIGN KEY (order_id) REFERENCES "order" (order_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_contract_device
        FOREIGN KEY (device_id) REFERENCES device_catalog (device_id)
        ON DELETE RESTRICT
);

-- 12. DELIVERY - courier tracking for dispatched orders. 1:1 with order.
CREATE TABLE IF NOT EXISTS delivery (
    delivery_id             SERIAL PRIMARY KEY,
    order_id                INTEGER UNIQUE NOT NULL,
    warehouse_op_user_id    INTEGER NOT NULL,
    courier_name            VARCHAR(255),
    tracking_number         VARCHAR(255) UNIQUE,
    delivery_address        TEXT NOT NULL,
    delivery_status         VARCHAR(50) NOT NULL
        CHECK (delivery_status IN ('Pending', 'In_Transit', 'Delivered', 'Failed')),
    dispatch_date           TIMESTAMP WITH TIME ZONE,
    estimated_delivery_date TIMESTAMP WITH TIME ZONE,
    actual_delivery_date    TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_delivery_order
        FOREIGN KEY (order_id) REFERENCES "order" (order_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_delivery_warehouse
        FOREIGN KEY (warehouse_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 13. AUDIT_LOG - append-only record of significant actions.
CREATE TABLE IF NOT EXISTS audit_log (
    log_id      BIGSERIAL PRIMARY KEY,
    actor_id    INTEGER      NOT NULL,
    actor_type  VARCHAR(20)  NOT NULL,                      -- CHECK: PART 3
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INTEGER,
    old_value   JSONB,
    new_value   JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 14. REFRESH_TOKEN - hashed refresh tokens for the JWT flow.
CREATE TABLE IF NOT EXISTS refresh_token (
    token_id   SERIAL PRIMARY KEY,
    user_id    INTEGER      NOT NULL,
    user_type  VARCHAR(20)  NOT NULL
        CHECK (user_type IN ('Client', 'Operational')),
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 15. PASSWORD_RESET_TOKEN
CREATE TABLE IF NOT EXISTS password_reset_token (
    token_id   SERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    user_type  VARCHAR(20)  NOT NULL
        CHECK (user_type IN ('Client', 'Operational')),
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at    TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 16. LOGIN_ATTEMPT
CREATE TABLE IF NOT EXISTS login_attempt (
    attempt_id BIGSERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    ip_address INET,
    success    BOOLEAN      NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 17. DEVICE_RETURN - return lifecycle: Requested -> Approved -> Collected -> Assessed -> Completed.
--     initiated_by is NULL when the CLIENT asked for the return (initiated_by_type = Client).
CREATE TABLE IF NOT EXISTS device_return (
    return_id         SERIAL PRIMARY KEY,
    contract_id       INTEGER NOT NULL REFERENCES contract (contract_id)         ON DELETE RESTRICT,
    client_user_id    INTEGER NOT NULL REFERENCES client_user (client_user_id)   ON DELETE RESTRICT,
    initiated_by      INTEGER REFERENCES operational_user (op_user_id)           ON DELETE RESTRICT,
    initiated_by_type VARCHAR(20) NOT NULL DEFAULT 'Operational',
    return_status     VARCHAR(50) NOT NULL DEFAULT 'Requested'
        CHECK (return_status IN ('Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled')),
    return_reason     TEXT NOT NULL,
    condition_grade   VARCHAR(5),                                -- CHECK: PART 3
    condition_notes   TEXT,
    initiated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at       TIMESTAMP WITH TIME ZONE,
    collected_at      TIMESTAMP WITH TIME ZONE,
    assessed_at       TIMESTAMP WITH TIME ZONE,
    completed_at      TIMESTAMP WITH TIME ZONE,
    cancelled_at      TIMESTAMP WITH TIME ZONE,
    visible_to_client BOOLEAN NOT NULL DEFAULT false,            -- grade / notes shown to the client only when true
    CONSTRAINT chk_device_return_initiator CHECK (
        (initiated_by_type = 'Operational' AND initiated_by IS NOT NULL)
     OR (initiated_by_type = 'Client'      AND initiated_by IS NULL))
);

-- 18. APPROVAL_DELEGATION - a Manager temporarily delegates approval authority.
CREATE TABLE IF NOT EXISTS approval_delegation (
    delegation_id   SERIAL PRIMARY KEY,
    delegator_id    INTEGER NOT NULL REFERENCES operational_user (op_user_id) ON DELETE CASCADE,
    delegate_id     INTEGER NOT NULL REFERENCES operational_user (op_user_id) ON DELETE CASCADE,
    start_date      TIMESTAMP WITH TIME ZONE NOT NULL,
    end_date        TIMESTAMP WITH TIME ZONE NOT NULL,
    reason          TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_delegation_dates CHECK (end_date > start_date)
);

-- 19. DEPARTMENT_BUDGET - monthly spend ceiling per department per fiscal year.
CREATE TABLE IF NOT EXISTS department_budget (
    budget_id        SERIAL PRIMARY KEY,
    department_id    VARCHAR(50) NOT NULL,
    fiscal_year      INTEGER     NOT NULL,
    monthly_ceiling  NUMERIC(10, 2) NOT NULL CHECK (monthly_ceiling > 0),
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES operational_user (op_user_id) ON DELETE RESTRICT,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_dept_year UNIQUE (department_id, fiscal_year)
);

-- 20. STORAGE_FILES - upload metadata. The app (src/config/pgStorage.js) also
--     creates this on startup, so having it here keeps every database identical.
CREATE TABLE IF NOT EXISTS storage_files (
    id            SERIAL PRIMARY KEY,
    storage_path  TEXT        NOT NULL UNIQUE,
    original_name TEXT,
    mime_type     TEXT,
    file_size     INTEGER,
    folder        TEXT,
    user_id       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MANIFEST: what PART 1 produces, as data. Generated, do not edit by hand.
--   PART 2 uses it to refuse, with one clear message, a table that already exists
--   in a shape this file cannot repair. PART 6 uses it to compare the database.
-- To regenerate after a schema change: build a fresh database from this file, then
--   columns .... SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
--                WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
--   constraints .. one line per primary key, unique and foreign key: table, kind, columns, referenced table, delete action
-- =============================================================================
CREATE TEMP TABLE dojcd_cols AS SELECT unnest(ARRAY[
'client_user.client_user_id', 'client_user.title', 'client_user.first_name',
        'client_user.last_name', 'client_user.email', 'client_user.phone_number',
        'client_user.region', 'client_user.persal_id', 'client_user.department_id',
        'client_user.user_type', 'client_user.password_hash', 'client_user.cognito_id',
        'client_user.network_provider', 'client_user.contract_duration_months',
        'client_user.contract_end_date', 'client_user.invoice_path',
        'client_user.registration_status', 'client_user.verification_notes',
        'client_user.created_at', 'client_user.updated_at', 'device_catalog.device_id',
        'device_catalog.device_name', 'device_catalog.model', 'device_catalog.manufacturer',
        'device_catalog.plan_name', 'device_catalog.plan_details', 'device_catalog.monthly_cost',
        'device_catalog.contract_duration_months', 'device_catalog.status',
        'device_catalog.stock_quantity', 'device_catalog.created_at', 'device_catalog.updated_at',
        'operational_user.op_user_id', 'operational_user.title', 'operational_user.first_name',
        'operational_user.last_name', 'operational_user.email', 'operational_user.user_role',
        'operational_user.department_id', 'operational_user.password_hash',
        'operational_user.cognito_id', 'operational_user.must_change_password',
        'operational_user.is_super_admin', 'operational_user.has_global_access',
        'operational_user.is_deleted', 'operational_user.deleted_at',
        'operational_user.created_at', 'operational_user.updated_at', 'department.id',
        'department.name', 'department.code', 'department.created_at',
        'application.application_id', 'application.client_user_id', 'application.device_id',
        'application.application_status', 'application.submission_date',
        'application.last_updated', 'application.rejection_reason',
        'application.parent_application_id', 'notification.notification_id',
        'notification.user_id', 'notification.user_type', 'notification.title',
        'notification.message', 'notification.is_read', 'notification.created_at',
        'document.document_id', 'document.application_id', 'document.client_user_id',
        'document.document_type', 'document.file_path', 'document.upload_date',
        'document.document_status', 'document.verification_notes', 'document.verification_date',
        'approval.approval_id', 'approval.application_id', 'approval.approver_op_user_id',
        'approval.approval_stage', 'approval.approval_status', 'approval.approval_date',
        'approval.notes', 'order.order_id', 'order.application_id', 'order.mtn_staff_op_user_id',
        'order.order_status', 'order.order_date', 'order.warehouse_ref', 'order.notes',
        'report.report_id', 'report.report_name', 'report.generated_date', 'report.file_path',
        'report.admin_op_user_id', 'contract.contract_id', 'contract.order_id',
        'contract.device_id', 'contract.imei', 'contract.sim_number', 'contract.billing_plan_ref',
        'contract.activation_date', 'contract.mtn_contract_ref', 'delivery.delivery_id',
        'delivery.order_id', 'delivery.warehouse_op_user_id', 'delivery.courier_name',
        'delivery.tracking_number', 'delivery.delivery_address', 'delivery.delivery_status',
        'delivery.dispatch_date', 'delivery.estimated_delivery_date',
        'delivery.actual_delivery_date', 'audit_log.log_id', 'audit_log.actor_id',
        'audit_log.actor_type', 'audit_log.action', 'audit_log.entity_type', 'audit_log.entity_id',
        'audit_log.old_value', 'audit_log.new_value', 'audit_log.ip_address',
        'audit_log.user_agent', 'audit_log.created_at', 'refresh_token.token_id',
        'refresh_token.user_id', 'refresh_token.user_type', 'refresh_token.token_hash',
        'refresh_token.expires_at', 'refresh_token.revoked_at', 'refresh_token.created_at',
        'password_reset_token.token_id', 'password_reset_token.email',
        'password_reset_token.user_type', 'password_reset_token.token_hash',
        'password_reset_token.expires_at', 'password_reset_token.used_at',
        'password_reset_token.created_at', 'login_attempt.attempt_id', 'login_attempt.email',
        'login_attempt.ip_address', 'login_attempt.success', 'login_attempt.created_at',
        'device_return.return_id', 'device_return.contract_id', 'device_return.client_user_id',
        'device_return.initiated_by', 'device_return.initiated_by_type',
        'device_return.return_status', 'device_return.return_reason',
        'device_return.condition_grade', 'device_return.condition_notes',
        'device_return.initiated_at', 'device_return.approved_at', 'device_return.collected_at',
        'device_return.assessed_at', 'device_return.completed_at', 'device_return.cancelled_at',
        'device_return.visible_to_client',
        'approval_delegation.delegation_id', 'approval_delegation.delegator_id',
        'approval_delegation.delegate_id', 'approval_delegation.start_date',
        'approval_delegation.end_date', 'approval_delegation.reason',
        'approval_delegation.is_active', 'approval_delegation.created_at',
        'department_budget.budget_id', 'department_budget.department_id',
        'department_budget.fiscal_year', 'department_budget.monthly_ceiling',
        'department_budget.notes', 'department_budget.created_by', 'department_budget.created_at',
        'department_budget.updated_at', 'storage_files.id', 'storage_files.storage_path',
        'storage_files.original_name', 'storage_files.mime_type', 'storage_files.file_size',
        'storage_files.folder', 'storage_files.user_id', 'storage_files.created_at']) AS tc;CREATE TEMP TABLE dojcd_cons AS SELECT unnest(ARRAY[
'client_user PRIMARY KEY (client_user_id)',
        'client_user UNIQUE (cognito_id)',
        'client_user UNIQUE (email)',
        'client_user UNIQUE (persal_id)',
        'device_catalog PRIMARY KEY (device_id)',
        'operational_user PRIMARY KEY (op_user_id)',
        'operational_user UNIQUE (cognito_id)',
        'operational_user UNIQUE (email)',
        'department PRIMARY KEY (id)',
        'department UNIQUE (name)',
        'application FOREIGN KEY (client_user_id) REFERENCES client_user (client_user_id) ON DELETE RESTRICT',
        'application FOREIGN KEY (device_id) REFERENCES device_catalog (device_id) ON DELETE RESTRICT',
        'application FOREIGN KEY (parent_application_id) REFERENCES application (application_id) ON DELETE SET NULL',
        'application PRIMARY KEY (application_id)',
        'notification PRIMARY KEY (notification_id)',
        'document FOREIGN KEY (application_id) REFERENCES application (application_id) ON DELETE CASCADE',
        'document FOREIGN KEY (client_user_id) REFERENCES client_user (client_user_id) ON DELETE RESTRICT',
        'document PRIMARY KEY (document_id)',
        'approval FOREIGN KEY (application_id) REFERENCES application (application_id) ON DELETE CASCADE',
        'approval FOREIGN KEY (approver_op_user_id) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'approval PRIMARY KEY (approval_id)',
        'order FOREIGN KEY (application_id) REFERENCES application (application_id) ON DELETE CASCADE',
        'order FOREIGN KEY (mtn_staff_op_user_id) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'order PRIMARY KEY (order_id)',
        'order UNIQUE (application_id)',
        'report FOREIGN KEY (admin_op_user_id) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'report PRIMARY KEY (report_id)',
        'contract FOREIGN KEY (device_id) REFERENCES device_catalog (device_id) ON DELETE RESTRICT',
        'contract FOREIGN KEY (order_id) REFERENCES order (order_id) ON DELETE CASCADE',
        'contract PRIMARY KEY (contract_id)',
        'contract UNIQUE (imei)',
        'contract UNIQUE (mtn_contract_ref)',
        'contract UNIQUE (order_id)',
        'contract UNIQUE (sim_number)',
        'delivery FOREIGN KEY (order_id) REFERENCES order (order_id) ON DELETE CASCADE',
        'delivery FOREIGN KEY (warehouse_op_user_id) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'delivery PRIMARY KEY (delivery_id)',
        'delivery UNIQUE (order_id)',
        'delivery UNIQUE (tracking_number)',
        'audit_log PRIMARY KEY (log_id)',
        'refresh_token PRIMARY KEY (token_id)',
        'refresh_token UNIQUE (token_hash)',
        'password_reset_token PRIMARY KEY (token_id)',
        'password_reset_token UNIQUE (token_hash)',
        'login_attempt PRIMARY KEY (attempt_id)',
        'device_return FOREIGN KEY (client_user_id) REFERENCES client_user (client_user_id) ON DELETE RESTRICT',
        'device_return FOREIGN KEY (contract_id) REFERENCES contract (contract_id) ON DELETE RESTRICT',
        'device_return FOREIGN KEY (initiated_by) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'device_return PRIMARY KEY (return_id)',
        'approval_delegation FOREIGN KEY (delegate_id) REFERENCES operational_user (op_user_id) ON DELETE CASCADE',
        'approval_delegation FOREIGN KEY (delegator_id) REFERENCES operational_user (op_user_id) ON DELETE CASCADE',
        'approval_delegation PRIMARY KEY (delegation_id)',
        'department_budget FOREIGN KEY (created_by) REFERENCES operational_user (op_user_id) ON DELETE RESTRICT',
        'department_budget PRIMARY KEY (budget_id)',
        'department_budget UNIQUE (department_id,fiscal_year)',
        'storage_files PRIMARY KEY (id)',
        'storage_files UNIQUE (storage_path)']) AS sig;

-- =============================================================================
-- PART 2: BRING OLDER DATABASES UP TO DATE
--    Every step looks in the catalog first, so on an up-to-date database this
--    part changes nothing and takes no heavy locks.
-- =============================================================================

-- Columns that older copies of the schema do not have.
DO $$
BEGIN
    PERFORM pg_temp.add_column('approval',         'approval_stage',        'VARCHAR(20)');
    PERFORM pg_temp.add_column('operational_user', 'is_deleted',            'BOOLEAN NOT NULL DEFAULT false');
    PERFORM pg_temp.add_column('operational_user', 'deleted_at',            'TIMESTAMP WITH TIME ZONE');
    PERFORM pg_temp.add_column('operational_user', 'department_id',         'VARCHAR(50)');
    PERFORM pg_temp.add_column('operational_user', 'has_global_access',     'BOOLEAN NOT NULL DEFAULT false');
    PERFORM pg_temp.add_column('device_catalog',   'stock_quantity',        'INTEGER CHECK (stock_quantity >= 0)');
    PERFORM pg_temp.add_column('application',      'parent_application_id', 'INTEGER REFERENCES application (application_id) ON DELETE SET NULL');
    PERFORM pg_temp.add_column('order',            'notes',                 'TEXT');
    PERFORM pg_temp.add_column('department',       'code',                  'VARCHAR(50)');
    PERFORM pg_temp.add_column('department',       'created_at',            'TIMESTAMPTZ DEFAULT NOW()');
    -- migration 009: client-initiated returns
    PERFORM pg_temp.add_column('device_return',    'initiated_by_type',     'VARCHAR(20) NOT NULL DEFAULT ''Operational''');
    PERFORM pg_temp.add_column('device_return',    'approved_at',           'TIMESTAMP WITH TIME ZONE');
    PERFORM pg_temp.add_column('device_return',    'assessed_at',           'TIMESTAMP WITH TIME ZONE');
    PERFORM pg_temp.add_column('device_return',    'cancelled_at',          'TIMESTAMP WITH TIME ZONE');
    PERFORM pg_temp.add_column('device_return',    'visible_to_client',     'BOOLEAN NOT NULL DEFAULT false');
END
$$;

-- Migration 009: initiated_by must allow NULL (a client is not an operational user), guarded by a rule.
DO $$
DECLARE
    rel regclass := to_regclass('public.device_return');
BEGIN
    IF rel IS NULL THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'initiated_by' AND attnotnull) THEN
        ALTER TABLE public.device_return ALTER COLUMN initiated_by DROP NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = rel AND conname = 'chk_device_return_initiator') THEN
        ALTER TABLE public.device_return ADD CONSTRAINT chk_device_return_initiator CHECK (
            (initiated_by_type = 'Operational' AND initiated_by IS NOT NULL)
         OR (initiated_by_type = 'Client'      AND initiated_by IS NULL));
    END IF;
END
$$;

-- Migration 005: s3_path -> file_path (only if the old name is still there and the new one is not).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['document', 'report'] LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 's3_path') THEN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = t AND column_name = 'file_path') THEN
                RAISE WARNING 'public.% has BOTH s3_path and file_path. Left alone: copy the values yourself and drop s3_path.', t;
            ELSE
                EXECUTE format('ALTER TABLE public.%I RENAME COLUMN s3_path TO file_path', t);
                RAISE WARNING 'renamed %.s3_path to file_path. Check your own functions, views and queries that mention s3_path.', t;
            END IF;
        END IF;
    END LOOP;
END
$$;

-- Migration 001: the two-stage workflow needs two approval rows per application,
-- so any 1:1 unique constraint or plain unique index on application_id must go.
DO $$
DECLARE
    rel regclass := to_regclass('public.approval');
    r   record;
    att smallint;
BEGIN
    IF rel IS NULL THEN RETURN; END IF;
    SELECT attnum INTO att FROM pg_attribute WHERE attrelid = rel AND attname = 'application_id';
    IF att IS NULL THEN RETURN; END IF;
    FOR r IN SELECT conname, oid, conindid FROM pg_constraint
              WHERE conrelid = rel AND contype = 'u' AND conkey = ARRAY[att]
    LOOP
        PERFORM 1 FROM pg_constraint f WHERE f.contype = 'f' AND f.confrelid = rel AND f.conindid = r.conindid;
        IF FOUND THEN
            RAISE EXCEPTION 'approval.application_id is UNIQUE and another table has a foreign key that depends on it. Two-stage approval needs several approval rows per application.'
                  USING HINT = 'Point that foreign key at approval.approval_id (or drop it), then re-run. Nothing was changed.';
        END IF;
        EXECUTE format('ALTER TABLE public.approval DROP CONSTRAINT %I', r.conname);
    END LOOP;
    FOR r IN SELECT i.indexrelid::regclass::text AS idx
               FROM pg_index i
              WHERE i.indrelid = rel AND i.indisunique AND NOT i.indisprimary
                AND i.indnatts = 1 AND i.indkey[0] = att AND i.indpred IS NULL
                AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
    LOOP
        EXECUTE format('DROP INDEX %s', r.idx);
    END LOOP;
END
$$;

-- Migration 002 created idx_op_user_department, an exact duplicate of
-- idx_operational_user_department (PART 4). Drop it only if it really is identical.
DO $$
DECLARE
    def text;
BEGIN
    SELECT regexp_replace(indexdef, '^CREATE INDEX \S+ ON ', 'CREATE INDEX x ON ') INTO def
      FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_op_user_department';
    IF def = 'CREATE INDEX x ON public.operational_user USING btree (department_id) WHERE (department_id IS NOT NULL)' THEN
        DROP INDEX public.idx_op_user_department;
    END IF;
END
$$;

-- Very old copies of the base schema declared these columns without NOT NULL
-- (CREATE TABLE IF NOT EXISTS cannot fix that). Tighten them only when no row
-- holds NULL, so this can never fail on real data. PART 6 reports any left over.
DO $$
DECLARE
    r record;
    n bigint;
BEGIN
    FOR r IN SELECT * FROM (VALUES
                 ('client_user',      'registration_status'),
                 ('notification',     'is_read'),
                 ('operational_user', 'is_super_admin'),
                 ('operational_user', 'must_change_password')
             ) AS v(t, c)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass(format('public.%I', r.t)) AND attname = r.c
                      AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) THEN
            EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NULL', r.t, r.c) INTO n;
            IF n = 0 THEN
                EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL', r.t, r.c);
            ELSE
                RAISE WARNING 'skipped NOT NULL on %.%: % rows are NULL. Fix them, then re-run.', r.t, r.c, n;
            END IF;
        END IF;
    END LOOP;
END
$$;

-- A hand-made department table may lack UNIQUE(name), which the app relies on. Add it when no two
-- departments share a name. Otherwise leave it and let PART 6 report the missing constraint.
DO $$
DECLARE
    rel regclass := to_regclass('public.department');
BEGIN
    IF rel IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = rel AND attname = 'name' AND attnum > 0 AND NOT attisdropped) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = rel AND c.contype IN ('u', 'p')
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = 'name')]) THEN RETURN; END IF;
    IF (SELECT count(*) = count(DISTINCT name) FROM public.department) THEN
        ALTER TABLE public.department ADD CONSTRAINT department_name_key UNIQUE (name);
    ELSE
        RAISE WARNING 'department has duplicate names, so UNIQUE (name) was not added. Merge the duplicates, then re-run.';
    END IF;
END
$$;

-- Pre-flight: a table with a template name may already exist in a shape this file cannot repair
-- (for example a hand-made department table). Say so ONCE, naming every table and column,
-- instead of failing later with a bare PostgreSQL error. Nothing has been changed yet.
DO $$
DECLARE
    msg text;
BEGIN
    SELECT string_agg(x.t || ' lacks: ' || x.cols, E'\n  - ' ORDER BY x.t) INTO msg
      FROM (SELECT split_part(c.tc, '.', 1) AS t, string_agg(split_part(c.tc, '.', 2), ', ') AS cols
              FROM dojcd_cols c
             WHERE to_regclass(format('public.%I', split_part(c.tc, '.', 1))) IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                                WHERE a.attrelid = to_regclass(format('public.%I', split_part(c.tc, '.', 1)))
                                  AND a.attname = split_part(c.tc, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped)
             GROUP BY 1) x;
    IF msg IS NOT NULL THEN
        RAISE EXCEPTION E'These tables already exist but are missing columns this file needs and cannot add:\n  - %', msg
              USING HINT = 'Add the missing columns (or rename or move your table), then re-run. Nothing was changed.';
    END IF;
END
$$;

-- =============================================================================
-- PART 3: STATUS / ROLE CONSTRAINTS  (the one place these lists live)
--    The self-check in PART 6 reads this same list, so the two cannot disagree.
-- =============================================================================
CREATE TEMP TABLE dojcd_checks (tbl text, col text, name text, expr text);INSERT INTO dojcd_checks VALUES
    ('client_user', 'registration_status', 'client_user_registration_status_check',
        $c$registration_status IN ('Pending', 'Profile_Completed', 'Verified', 'Rejected', 'Deactivated')$c$),
    ('application', 'application_status', 'application_application_status_check',
        $c$application_status IN ('Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled')$c$),
    ('operational_user', 'user_role', 'operational_user_user_role_check',
        $c$user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance')$c$),
    ('approval', 'approval_stage', 'approval_approval_stage_check',
        $c$approval_stage IN ('manager', 'finance', 'admin')$c$),
    ('device_return', 'condition_grade', 'device_return_condition_grade_check',
        $c$condition_grade IN ('A', 'B', 'C', 'D')$c$),
    -- The app writes BOTH spellings today: the capitalised ones from most services and the
    -- lowercase ones from budgetService and delegationService. The live database built from
    -- all_migrations.sql already allows both. Remove the lowercase ones if those services change.
    ('audit_log', 'actor_type', 'audit_log_actor_type_check',
        $c$actor_type IN ('Client', 'Operational', 'System', 'client_user', 'operational_user', 'system')$c$);
-- First look at ALL the rules and report every violation at once (rules already applied are skipped).
DO $$
DECLARE
    r    record;
    v    text;
    msg  text := '';
BEGIN
    FOR r IN SELECT * FROM dojcd_checks ORDER BY tbl, col LOOP
        IF to_regclass(format('public.%I', r.tbl)) IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint k
             WHERE k.conrelid = to_regclass(format('public.%I', r.tbl)) AND k.conname = r.name
               AND obj_description(k.oid, 'pg_constraint') = 'dojcd:' || md5(r.expr)) THEN
            v := pg_temp.check_violations(r.tbl, r.col, r.expr);
            IF v IS NOT NULL THEN
                msg := msg || E'\n  - ' || r.tbl || '.' || r.col || ' holds values this file does not allow: ' || v;
            END IF;
        END IF;
    END LOOP;
    IF msg <> '' THEN
        RAISE EXCEPTION E'Existing rows break the rules in PART 3 of dojcd_db.sql:%', msg
              USING HINT = 'Update those rows. If a value is legitimate for the whole project, add it to PART 3 and commit that change. Nothing has been changed.';
    END IF;
    FOR r IN SELECT * FROM dojcd_checks LOOP
        PERFORM pg_temp.set_check(r.tbl, r.col, r.name, r.expr);
    END LOOP;
END
$$;

-- =============================================================================
-- PART 4: INDEXES
-- =============================================================================
CREATE TEMP TABLE dojcd_indexes (name text, ddl text);INSERT INTO dojcd_indexes VALUES
        ('idx_operational_user_active',      'CREATE INDEX idx_operational_user_active ON public.operational_user (is_deleted) WHERE is_deleted = false'),
        ('idx_operational_user_department',  'CREATE INDEX idx_operational_user_department ON public.operational_user (department_id) WHERE department_id IS NOT NULL'),
        ('idx_application_parent',           'CREATE INDEX idx_application_parent ON public.application (parent_application_id) WHERE parent_application_id IS NOT NULL'),
        ('idx_approval_application_stage',    'CREATE INDEX idx_approval_application_stage ON public.approval (application_id, approval_stage)'),
        ('idx_audit_entity',                  'CREATE INDEX idx_audit_entity ON public.audit_log (entity_type, entity_id)'),
        ('idx_audit_actor',                   'CREATE INDEX idx_audit_actor ON public.audit_log (actor_id, actor_type, created_at DESC)'),
        ('idx_audit_created',                 'CREATE INDEX idx_audit_created ON public.audit_log (created_at DESC)'),
        ('idx_refresh_token_user',            'CREATE INDEX idx_refresh_token_user ON public.refresh_token (user_id, user_type)'),
        ('idx_refresh_token_hash',            'CREATE INDEX idx_refresh_token_hash ON public.refresh_token (token_hash)'),
        ('idx_prt_email',                     'CREATE INDEX idx_prt_email ON public.password_reset_token (email, created_at DESC)'),
        ('idx_prt_hash',                      'CREATE INDEX idx_prt_hash ON public.password_reset_token (token_hash)'),
        ('idx_login_attempt_email',           'CREATE INDEX idx_login_attempt_email ON public.login_attempt (email, created_at DESC)'),
        ('idx_login_attempt_ip',              'CREATE INDEX idx_login_attempt_ip ON public.login_attempt (ip_address, created_at DESC)'),
        -- at most one in-flight return per contract
        ('uq_active_return_per_contract',     'CREATE UNIQUE INDEX uq_active_return_per_contract ON public.device_return (contract_id) WHERE return_status NOT IN (''Completed'', ''Cancelled'')'),
        -- at most one active delegation per delegator
        ('uq_one_active_delegation_per_delegator', 'CREATE UNIQUE INDEX uq_one_active_delegation_per_delegator ON public.approval_delegation (delegator_id) WHERE is_active = TRUE');DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM dojcd_indexes LOOP
        PERFORM pg_temp.ensure_index(r.name, r.ddl);
    END LOOP;
END
$$;

-- =============================================================================
-- PART 5: REFERENCE DATA  (safe to re-run: never overwrites or duplicates a row)
-- =============================================================================

-- DoJ&CD department branches that clients register under. These names must match
-- the DEPARTMENTS array in DOJCD-Client-Web/src/screens/Auth/ClientRegisterScreen.jsx
-- exactly, because client_user.department_id stores the department name as text.
INSERT INTO department (name, code)
SELECT v.name, v.code
  FROM (VALUES
    ('DoJ&CD Commission',     'COMM'),
    ('DoJ&CD Gauteng',        'GP'),
    ('DoJ&CD Eastern Cape',   'EC'),
    ('DoJ&CD KwaZulu Natal',  'KZN'),
    ('DoJ&CD Mpumalanga',     'MP'),
    ('DoJ&CD Northern Cape',  'NC'),
    ('DoJ&CD Western Cape',   'WC'),
    ('DoJ&CD Limpopo',        'LP'),
    ('DoJ&CD North West',     'NW'),
    ('DoJ&CD Free State',     'FS')
  ) AS v(name, code)
 WHERE NOT EXISTS (SELECT 1 FROM department d WHERE d.name = v.name);

-- Sample devices for local testing. ONLY when this session ran
--   SET dojcd.with_samples = 'on'
-- before the file (see the header). Skipped if the same device + plan exists.
INSERT INTO device_catalog
    (device_name, model, manufacturer, plan_name, plan_details,
     monthly_cost, contract_duration_months, status)
SELECT v.*
  FROM (VALUES
    ('Samsung Galaxy A14',    'SM-A145F', 'Samsung', 'MTN Smart 5GB',    '5GB data, Unlimited calls, 100 SMS',        299.99, 24, 'active'),
    ('iPhone 13',             'A2631',    'Apple',   'MTN Premium 10GB', '10GB data, Unlimited calls, Unlimited SMS', 899.99, 24, 'active'),
    ('Huawei Nova Y70',       'JLN-LX1',  'Huawei',  'MTN Basic 3GB',    '3GB data, 100 minutes, 50 SMS',             199.99, 24, 'active'),
    ('Nokia G21',             'TA-1406',  'Nokia',   'MTN Value 2GB',    '2GB data, 60 minutes, 30 SMS',              149.99, 24, 'active'),
    ('Samsung Galaxy Tab A8', 'SM-X205',  'Samsung', 'MTN Tablet 15GB',  '15GB data, Unlimited Wi-Fi calling',        399.99, 24, 'active'),
    ('Huawei MatePad T10',    'AGS3-L09', 'Huawei',  'MTN Tablet 10GB',  '10GB data, Unlimited Wi-Fi calling',        349.99, 24, 'active'),
    ('MTN 5G Router',         'MR1000',   'MTN',     'MTN Home 100GB',   '100GB data, Unlimited off-peak',            499.99, 24, 'active'),
    ('Huawei 4G Router',      'B535-232', 'Huawei',  'MTN Office 50GB',  '50GB data, 32 devices',                     349.99, 24, 'active')
  ) AS v(device_name, model, manufacturer, plan_name, plan_details,
         monthly_cost, contract_duration_months, status)
 WHERE lower(btrim(coalesce(nullif(current_setting('dojcd.with_samples', true), ''), 'off')))
           IN ('on', 'true', '1', 'yes', 'y', 't')
   AND NOT EXISTS (
        SELECT 1 FROM device_catalog d
         WHERE d.device_name = v.device_name AND d.plan_name = v.plan_name);

-- Proof for PART 6 that PART 1 to 5 ran to the end. If any statement above failed
-- this table is rolled back with everything else and PART 6 says so.
CREATE TEMP TABLE dojcd_run_ok AS SELECT 1 AS ok;

COMMIT;

-- =============================================================================
-- PART 6: SELF-CHECK  (read-only, runs after COMMIT, so a failure here never
--    undoes the schema work above)
-- =============================================================================
-- Compares THIS database with the template and prints the result as notices.
--   FAIL  when the run did not complete, or a template table, column or rule is
--         missing. The error lists every problem.
--   INFO  lists tables and columns that exist in this database but are NOT in
--         this file, i.e. things someone created locally and never committed.
--         The message includes the pg_dump command that captures the tables.
DO $check$
DECLARE
    expected_tables  text[] := ARRAY[
        'client_user', 'device_catalog', 'operational_user', 'department',
        'application', 'notification', 'document', 'approval', 'order',
        'report', 'contract', 'delivery', 'audit_log', 'refresh_token',
        'password_reset_token', 'login_attempt', 'device_return',
        'approval_delegation', 'department_budget', 'storage_files'];
    -- Read from the MANIFEST above. Constraints are described by what they do (columns, referenced
    -- table, delete action) and NOT by name, because older databases name the same constraints
    -- differently. The CHECK rules managed in PART 3 are verified by fingerprint.
    expected_columns     text[];
    expected_constraints text[];
    missing_tables text;
    missing_cols   text;
    extra_cols     text;
    missing_cons   text;
    extra_cons     text;
    missing_idx    text;
    extra_tables   text;
    extra_dump     text;
    bad_rules      text;
    null_cols      text;
    problems       text[] := '{}';
    n_expected     int := array_length(expected_tables, 1);
    n_present      int;
    r              record;
    rel            regclass;
    att            smallint;
BEGIN
    -- Wait for any other run of this file that is still inside its transaction.
    PERFORM pg_advisory_xact_lock(hashtext('dojcd_db.sql'));
    -- Show these notices even if the session hides notices.
    PERFORM set_config('client_min_messages', 'notice', true);
    IF to_regclass('pg_temp.dojcd_run_ok') IS NULL THEN
        RAISE EXCEPTION 'dojcd_db.sql did NOT complete, so nothing was changed. Find the first ERROR above this message and fix it. Run with -v ON_ERROR_STOP=1 to stop right there.';
    END IF;
    expected_columns     := ARRAY(SELECT tc FROM dojcd_cols);
    expected_constraints := ARRAY(SELECT sig FROM dojcd_cons);
    SELECT count(*) INTO n_present
      FROM unnest(expected_tables) AS e(t)
     WHERE to_regclass(format('public.%I', e.t)) IS NOT NULL;
    SELECT string_agg(e.t, ', ' ORDER BY e.t) INTO missing_tables
      FROM unnest(expected_tables) AS e(t)
     WHERE to_regclass(format('public.%I', e.t)) IS NULL;
    SELECT string_agg(c.tc, ', ' ORDER BY c.tc) INTO missing_cols
      FROM unnest(expected_columns) AS c(tc)
     WHERE to_regclass(format('public.%I', split_part(c.tc, '.', 1))) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = to_regclass(format('public.%I', split_part(c.tc, '.', 1)))
                          AND a.attname = split_part(c.tc, '.', 2) AND a.attnum > 0 AND NOT a.attisdropped);
    SELECT string_agg(k.tc, ', ' ORDER BY k.tc) INTO extra_cols
      FROM (SELECT c.relname || '.' || a.attname AS tc
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
               AND c.relname = ANY (expected_tables)
               AND a.attnum > 0 AND NOT a.attisdropped) AS k
     WHERE k.tc <> ALL (expected_columns);
    IF to_regclass('pg_temp.dojcd_actual_cons') IS NOT NULL THEN DROP TABLE pg_temp.dojcd_actual_cons; END IF;
    CREATE TEMP TABLE dojcd_actual_cons ON COMMIT DROP AS
    SELECT cl.relname || ' ' ||
           CASE c.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' ELSE 'FOREIGN KEY' END ||
           ' (' || (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                      FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || ')' ||
           CASE WHEN c.contype = 'f' THEN
                ' REFERENCES ' || fcl.relname || ' (' ||
                (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                   FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) ||
                ') ON DELETE ' ||
                CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                                   WHEN 'n' THEN 'SET NULL' ELSE 'SET DEFAULT' END
           ELSE '' END AS sig
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      LEFT JOIN pg_class fcl ON fcl.oid = c.confrelid
     WHERE n.nspname = 'public' AND cl.relname = ANY (expected_tables) AND c.contype IN ('p', 'u', 'f');
    SELECT string_agg(k.sig, E'\n      ' ORDER BY k.sig) INTO missing_cons
      FROM unnest(expected_constraints) AS k(sig)
     WHERE split_part(k.sig, ' ', 1) = ANY (SELECT e FROM unnest(expected_tables) AS e WHERE to_regclass(format('public.%I', e)) IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM dojcd_actual_cons a WHERE a.sig = k.sig);
    SELECT string_agg(a.sig, E'\n      ' ORDER BY a.sig) INTO extra_cons
      FROM dojcd_actual_cons a WHERE a.sig <> ALL (expected_constraints);
    SELECT string_agg(i.name, ', ' ORDER BY i.name) INTO missing_idx
      FROM dojcd_indexes i WHERE to_regclass(format('public.%I', i.name)) IS NULL;
    IF missing_tables IS NOT NULL THEN
        problems := problems || format('missing tables: %s', missing_tables);
    END IF;
    IF missing_cols IS NOT NULL THEN
        problems := problems || format('missing columns: %s', missing_cols);
    END IF;
    IF missing_cons IS NOT NULL THEN
        problems := problems || format('missing constraints:%s', E'\n      ' || missing_cons);
    END IF;
    IF missing_idx IS NOT NULL THEN
        problems := problems || format('missing indexes: %s', missing_idx);
    END IF;
    -- Every managed rule must be exactly the template rule (checked by fingerprint).
    FOR r IN SELECT * FROM dojcd_checks ORDER BY tbl, col LOOP
        rel := to_regclass(format('public.%I', r.tbl));
        IF rel IS NULL THEN CONTINUE; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                        WHERE k.conrelid = rel AND k.conname = r.name AND k.contype = 'c'
                          AND obj_description(k.oid, 'pg_constraint') = 'dojcd:' || md5(r.expr)) THEN
            bad_rules := coalesce(bad_rules || ', ', '') || r.tbl || '.' || r.col;
        END IF;
    END LOOP;
    IF bad_rules IS NOT NULL THEN
        problems := problems || format('rules that are not the template rule (see the ERROR above): %s', bad_rules);
    END IF;
    -- Columns the template wants NOT NULL that still allow NULL (rows with NULL block the change).
    FOR r IN SELECT * FROM (VALUES
                 ('client_user', 'registration_status'), ('notification', 'is_read'),
                 ('operational_user', 'is_super_admin'), ('operational_user', 'must_change_password')) AS v(t, c)
    LOOP
        rel := to_regclass(format('public.%I', r.t));
        IF rel IS NOT NULL AND EXISTS (SELECT 1 FROM pg_attribute
                                        WHERE attrelid = rel AND attname = r.c AND attnum > 0
                                          AND NOT attisdropped AND NOT attnotnull) THEN
            null_cols := coalesce(null_cols || ', ', '') || r.t || '.' || r.c;
        END IF;
    END LOOP;
    IF null_cols IS NOT NULL THEN
        problems := problems || format('columns that should be NOT NULL but hold NULL rows (fix the rows and re-run): %s', null_cols);
    END IF;
    rel := to_regclass('public.approval');
    IF rel IS NOT NULL THEN
        SELECT attnum INTO att FROM pg_attribute WHERE attrelid = rel AND attname = 'application_id';
        IF EXISTS (SELECT 1 FROM pg_index i
                    WHERE i.indrelid = rel AND i.indisunique AND NOT i.indisprimary
                      AND i.indnatts = 1 AND i.indkey[0] = att AND i.indpred IS NULL) THEN
            problems := problems || 'approval.application_id is still UNIQUE, so two-stage approval will fail'::text;
        END IF;
    END IF;
    -- Tables here that this file does not know about.
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname),
           string_agg('-t ' || CASE WHEN quote_ident(c.relname) = c.relname THEN c.relname
                           ELSE quote_literal(quote_ident(c.relname)) END, ' ' ORDER BY c.relname)
      INTO extra_tables, extra_dump
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND c.relname <> ALL (expected_tables);
    RAISE NOTICE 'Database "%", schema public: % of % template tables present.',
                 current_database(), n_present, n_expected;
    IF extra_tables IS NOT NULL THEN
        RAISE NOTICE 'INFO  tables NOT in dojcd_db.sql (created locally?): %', extra_tables;
        RAISE NOTICE '      capture the tables:  pg_dump -s --no-owner --no-privileges -d % % > local_only_tables.sql',
                     current_database(), extra_dump;
    END IF;
    IF extra_cols IS NOT NULL THEN
        RAISE NOTICE 'INFO  columns NOT in dojcd_db.sql (added locally?): %', extra_cols;
    END IF;
    IF extra_cons IS NOT NULL THEN
        RAISE NOTICE 'INFO  constraints NOT in dojcd_db.sql (added locally?):%', E'\n      ' || extra_cons;
    END IF;
    IF array_length(problems, 1) > 0 THEN
        RAISE EXCEPTION E'Self-check FAILED:\n  - %',
                        array_to_string(problems, E'\n  - ')
              USING HINT = 'Re-run dojcd_db.sql with -v ON_ERROR_STOP=1. If this persists, the lines above say what is wrong.';
    END IF;
    RAISE NOTICE 'OK    schema matches dojcd_db.sql.';
END
$check$;

-- Leave nothing behind in a long-lived session (skipped if the self-check failed, harmless either way).
DROP FUNCTION IF EXISTS pg_temp.add_column(text, text, text);DROP FUNCTION IF EXISTS pg_temp.ensure_index(text, text);DROP FUNCTION IF EXISTS pg_temp.set_check(text, text, text, text);DROP FUNCTION IF EXISTS pg_temp.check_violations(text, text, text);DROP TABLE IF EXISTS pg_temp.dojcd_checks;DROP TABLE IF EXISTS pg_temp.dojcd_indexes;DROP TABLE IF EXISTS pg_temp.dojcd_cols;DROP TABLE IF EXISTS pg_temp.dojcd_cons;DROP TABLE IF EXISTS pg_temp.dojcd_run_ok;
