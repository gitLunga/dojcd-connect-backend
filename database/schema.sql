-- =============================================================================
-- DOJCD Connect — SHARED DATABASE TEMPLATE  (single source of truth)
-- =============================================================================
-- Brings ANY database to the current schema, whatever state it is in:
--
--   * empty database                         -> creates everything
--   * the old 15-table dojc_db.sql database  -> adds the missing tables/columns
--   * a partly-migrated database             -> fills in only what is missing
--   * an up-to-date database                 -> no-op (safe to re-run any time)
--
-- It replaces dojc_db.sql + migrations/001..008 + all_migrations.sql +
-- src/scripts/migrate-department-isolation.sql, which disagree with each other
-- and cannot be run in order on a fresh database (see database/README.md).
--
-- Never drops a table or deletes a row. Runs in ONE transaction: it either
-- applies completely or not at all.
--
-- USAGE
--   ./database/setup.sh                # reads DB_* from .env
--   psql -d <dbname> -v ON_ERROR_STOP=1 -f database/schema.sql
--
-- WHEN YOU CHANGE THE SCHEMA: edit THIS file (add the table/column/constraint
-- here), add the new table name to database/verify_schema.sql, commit both.
-- Do not make changes only in your local database.
--
-- Tables (20):
--    1 client_user        2 device_catalog     3 operational_user  4 department
--    5 application        6 notification      7 document          8 approval
--    9 order             10 report           11 contract         12 delivery
--   13 audit_log         14 refresh_token    15 password_reset_token
--   16 login_attempt     17 device_return    18 approval_delegation
--   19 department_budget 20 storage_files
-- =============================================================================

BEGIN;

-- Helper: replace every CHECK constraint that mentions <column> with one
-- canonical, named constraint. Used for status/role lists that have changed
-- over time, so old databases end up with exactly the same rules as new ones.
-- (pg_temp = exists only for this session, nothing is left in your database.)
CREATE OR REPLACE FUNCTION pg_temp.set_check(
    p_table regclass, p_column text, p_name text, p_expr text
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = p_table
           AND contype  = 'c'
           AND pg_get_constraintdef(oid) ~ ('\m' || p_column || '\M')
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)',
                   p_table, p_name, p_expr);
END
$fn$;

-- =============================================================================
-- 1. TABLES  (final shape, in foreign-key dependency order)
--    status/role CHECK constraints are NOT inline here: they are defined once,
--    in section 3, so there is a single list to maintain.
-- =============================================================================

-- 1. CLIENT_USER — Judges / Magistrates / Advocates who apply for devices.
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
    registration_status      VARCHAR(50) NOT NULL DEFAULT 'Pending',  -- CHECK: section 3
    verification_notes       TEXT,
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. DEVICE_CATALOG — devices and plans available for allocation.
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

-- 3. OPERATIONAL_USER — internal staff (soft-deleted so approval history survives).
CREATE TABLE IF NOT EXISTS operational_user (
    op_user_id           SERIAL PRIMARY KEY,
    title                VARCHAR(20),
    first_name           VARCHAR(255) NOT NULL,
    last_name            VARCHAR(255) NOT NULL,
    email                VARCHAR(255) UNIQUE NOT NULL,
    user_role            VARCHAR(50) NOT NULL,                     -- CHECK: section 3
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

-- 4. DEPARTMENT — lookup table (previously only created by a side script).
CREATE TABLE IF NOT EXISTS department (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL UNIQUE,
    code       VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. APPLICATION — a client's request for a device/plan.
CREATE TABLE IF NOT EXISTS application (
    application_id         SERIAL PRIMARY KEY,
    client_user_id         INTEGER NOT NULL,
    device_id              INTEGER NOT NULL,
    application_status     VARCHAR(50) NOT NULL,                   -- CHECK: section 3
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

-- 6. NOTIFICATION — in-app notifications (polymorphic user_id + user_type).
CREATE TABLE IF NOT EXISTS notification (
    notification_id SERIAL PRIMARY KEY,
    user_id         INTEGER      NOT NULL,
    user_type       VARCHAR(20)  NOT NULL CHECK (user_type IN ('Client', 'Operational')),
    title           VARCHAR(255) NOT NULL,
    message         TEXT         NOT NULL,
    is_read         BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. DOCUMENT — supporting documents (application_id nullable: uploaded before applying).
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

-- 8. APPROVAL — one row per stage per application (manager row + finance row).
--    application_id is deliberately NOT unique.
CREATE TABLE IF NOT EXISTS approval (
    approval_id         SERIAL PRIMARY KEY,
    application_id      INTEGER     NOT NULL,
    approver_op_user_id INTEGER     NOT NULL,
    approval_stage      VARCHAR(20),                               -- CHECK: section 3
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

-- 10. REPORT — generated report metadata.
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

-- 11. CONTRACT — activated on delivery (IMEI, SIM, MTN reference). 1:1 with order.
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

-- 12. DELIVERY — courier tracking for dispatched orders. 1:1 with order.
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

-- 13. AUDIT_LOG — append-only record of significant actions.
CREATE TABLE IF NOT EXISTS audit_log (
    log_id      BIGSERIAL PRIMARY KEY,
    actor_id    INTEGER      NOT NULL,
    actor_type  VARCHAR(20)  NOT NULL
        CHECK (actor_type IN ('Client', 'Operational', 'System')),
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INTEGER,
    old_value   JSONB,
    new_value   JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 14. REFRESH_TOKEN — hashed refresh tokens for the JWT flow.
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

-- 17. DEVICE_RETURN — return lifecycle: Requested -> Approved -> Collected -> Assessed -> Completed.
CREATE TABLE IF NOT EXISTS device_return (
    return_id         SERIAL PRIMARY KEY,
    contract_id       INTEGER NOT NULL REFERENCES contract (contract_id)         ON DELETE RESTRICT,
    client_user_id    INTEGER NOT NULL REFERENCES client_user (client_user_id)   ON DELETE RESTRICT,
    initiated_by      INTEGER NOT NULL REFERENCES operational_user (op_user_id)  ON DELETE RESTRICT,
    return_status     VARCHAR(50) NOT NULL DEFAULT 'Requested'
        CHECK (return_status IN ('Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled')),
    return_reason     TEXT NOT NULL,
    condition_grade   VARCHAR(5)
        CHECK (condition_grade IN ('A', 'B', 'C', 'D')),
    condition_notes   TEXT,
    initiated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    collected_at      TIMESTAMP WITH TIME ZONE,
    completed_at      TIMESTAMP WITH TIME ZONE
);

-- 18. APPROVAL_DELEGATION — a Manager temporarily delegates approval authority.
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

-- 19. DEPARTMENT_BUDGET — monthly spend ceiling per department per fiscal year.
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

-- 20. STORAGE_FILES — upload metadata. The app (src/config/pgStorage.js) also
--     creates this on startup; having it here keeps every database identical.
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
-- 2. BRING OLDER DATABASES UP TO DATE
--    No-ops on a database that was just created by section 1.
-- =============================================================================

-- Columns added by migrations 001/002/004 + the department-isolation script.
ALTER TABLE approval         ADD COLUMN IF NOT EXISTS approval_stage        VARCHAR(20);
ALTER TABLE operational_user ADD COLUMN IF NOT EXISTS is_deleted            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE operational_user ADD COLUMN IF NOT EXISTS deleted_at            TIMESTAMP WITH TIME ZONE;
ALTER TABLE operational_user ADD COLUMN IF NOT EXISTS department_id         VARCHAR(50);
ALTER TABLE operational_user ADD COLUMN IF NOT EXISTS has_global_access     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE device_catalog   ADD COLUMN IF NOT EXISTS stock_quantity        INTEGER CHECK (stock_quantity >= 0);
ALTER TABLE application      ADD COLUMN IF NOT EXISTS parent_application_id INTEGER
    REFERENCES application (application_id) ON DELETE SET NULL;

-- Migration 005: s3_path -> file_path (only if the old name is still there).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'document' AND column_name = 's3_path') THEN
        ALTER TABLE document RENAME COLUMN s3_path TO file_path;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'report' AND column_name = 's3_path') THEN
        ALTER TABLE report RENAME COLUMN s3_path TO file_path;
    END IF;
END
$$;

-- Migration 001: the two-stage workflow needs two approval rows per application,
-- so the old 1:1 unique constraint must go.
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_application_id_key;

-- Migration 002 created idx_op_user_department, an exact duplicate of
-- idx_operational_user_department (section 4). Keep one.
DROP INDEX IF EXISTS idx_op_user_department;

-- Very old copies of the base schema declared these columns without NOT NULL
-- (CREATE TABLE IF NOT EXISTS cannot fix that). Tighten them only when no row
-- holds NULL, so this can never fail on real data.
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
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = r.t AND column_name = r.c
                      AND is_nullable = 'YES') THEN
            EXECUTE format('SELECT count(*) FROM %I WHERE %I IS NULL', r.t, r.c) INTO n;
            IF n = 0 THEN
                EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', r.t, r.c);
            ELSE
                RAISE WARNING 'skipped NOT NULL on %.%: % rows are NULL. Fix them, then re-run.',
                             r.t, r.c, n;
            END IF;
        END IF;
    END LOOP;
END
$$;

-- =============================================================================
-- 3. STATUS / ROLE CONSTRAINTS  (the one place these lists live)
-- =============================================================================
DO $do$
BEGIN
    PERFORM pg_temp.set_check('client_user',      'registration_status', 'client_user_registration_status_check',
        $c$registration_status IN ('Pending', 'Profile_Completed', 'Verified', 'Rejected', 'Deactivated')$c$);

    PERFORM pg_temp.set_check('application',      'application_status', 'application_application_status_check',
        $c$application_status IN ('Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled')$c$);

    PERFORM pg_temp.set_check('operational_user', 'user_role',          'operational_user_user_role_check',
        $c$user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance')$c$);

    PERFORM pg_temp.set_check('approval',         'approval_stage',     'approval_approval_stage_check',
        $c$approval_stage IN ('manager', 'finance', 'admin')$c$);

    -- (migration 006 shipped this list with a pointless NULL in it)
    PERFORM pg_temp.set_check('device_return',    'condition_grade',    'device_return_condition_grade_check',
        $c$condition_grade IN ('A', 'B', 'C', 'D')$c$);
END
$do$;

-- =============================================================================
-- 4. INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_operational_user_active
    ON operational_user (is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_operational_user_department
    ON operational_user (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_application_parent
    ON application (parent_application_id) WHERE parent_application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_application_stage
    ON approval (application_id, approval_stage);
CREATE INDEX IF NOT EXISTS idx_audit_entity
    ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_log (actor_id, actor_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_token_user
    ON refresh_token (user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash
    ON refresh_token (token_hash);
CREATE INDEX IF NOT EXISTS idx_prt_email
    ON password_reset_token (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prt_hash
    ON password_reset_token (token_hash);
CREATE INDEX IF NOT EXISTS idx_login_attempt_email
    ON login_attempt (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip
    ON login_attempt (ip_address, created_at DESC);

-- At most one in-flight return per contract.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_return_per_contract
    ON device_return (contract_id) WHERE return_status NOT IN ('Completed', 'Cancelled');

-- At most one active delegation per delegator.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_delegation_per_delegator
    ON approval_delegation (delegator_id) WHERE is_active = TRUE;

COMMIT;
