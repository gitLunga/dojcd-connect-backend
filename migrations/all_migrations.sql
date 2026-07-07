-- =============================================================================
-- DOJCD Connect — Consolidated Database Migrations
-- =============================================================================
-- Single file that applies every migration from 001 through 006, plus the
-- department-isolation changes, in strict dependency order.
--
-- SAFE TO RUN ON:
--   • A brand-new (empty) database after dojc_db.sql has been applied.
--   • An existing VPS database that may already have some migrations applied.
--     Every statement uses IF NOT EXISTS / IF EXISTS / DO $$ guards.
--
-- EXCEPTION — the s3_path → file_path RENAME (section 6) uses a conditional
--   DO $$ block that skips silently if the column has already been renamed.
--
-- HOW TO RUN:
--   psql -U <user> -d <dbname> -f migrations/all_migrations.sql
--
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1  (from 001)
-- Fix schema mismatches and add Phase-1 tables
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. APPROVAL — drop the 1:1 unique constraint so two-stage workflow can insert
--     both a manager and a finance row for the same application.
ALTER TABLE approval
    DROP CONSTRAINT IF EXISTS approval_application_id_key;

ALTER TABLE approval
    ADD COLUMN IF NOT EXISTS approval_stage VARCHAR(20)
        CHECK (approval_stage IN ('manager', 'finance', 'admin'));

CREATE INDEX IF NOT EXISTS idx_approval_application_stage
    ON approval (application_id, approval_stage);

-- 1b. APPLICATION — add 'Pending_Finance' to the status check constraint.
ALTER TABLE application
    DROP CONSTRAINT IF EXISTS application_application_status_check;

ALTER TABLE application
    ADD CONSTRAINT application_application_status_check
        CHECK (application_status IN (
            'Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled'
        ));

-- 1c. OPERATIONAL_USER — add Manager and Finance to the role check constraint.
ALTER TABLE operational_user
    DROP CONSTRAINT IF EXISTS operational_user_user_role_check;

ALTER TABLE operational_user
    ADD CONSTRAINT operational_user_user_role_check
        CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'));

-- 1d. OPERATIONAL_USER — soft-delete support.
ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_operational_user_active
    ON operational_user (is_deleted)
    WHERE is_deleted = false;

-- 1e. AUDIT_LOG — immutable activity trail.
CREATE TABLE IF NOT EXISTS audit_log (
    log_id      BIGSERIAL PRIMARY KEY,
    actor_id    INTEGER      NOT NULL,
    actor_type  VARCHAR(20)  NOT NULL
        CHECK (actor_type IN ('Client', 'Operational', 'System',
                              'client_user', 'operational_user', 'system')),
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INTEGER,
    old_value   JSONB,
    new_value   JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity
    ON audit_log (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_log (actor_id, actor_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_log (created_at DESC);

-- 1f. REFRESH_TOKEN
CREATE TABLE IF NOT EXISTS refresh_token (
    token_id   SERIAL PRIMARY KEY,
    user_id    INTEGER     NOT NULL,
    user_type  VARCHAR(20) NOT NULL
        CHECK (user_type IN ('Client', 'Operational')),
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_user
    ON refresh_token (user_id, user_type);

CREATE INDEX IF NOT EXISTS idx_refresh_token_hash
    ON refresh_token (token_hash);

-- 1g. LOGIN_ATTEMPT — brute-force detection.
CREATE TABLE IF NOT EXISTS login_attempt (
    attempt_id BIGSERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    ip_address INET,
    success    BOOLEAN      NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_email
    ON login_attempt (email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempt_ip
    ON login_attempt (ip_address, created_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2  (from 002)
-- Add department_id to operational_user
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS department_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_op_user_department
    ON operational_user (department_id)
    WHERE department_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3  (from 003)
-- password_reset_token table
-- ─────────────────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_prt_email ON password_reset_token (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prt_hash  ON password_reset_token (token_hash);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4  (from 004)
-- Device stock tracking + application re-submission lineage
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE device_catalog
    ADD COLUMN IF NOT EXISTS stock_quantity INTEGER CHECK (stock_quantity >= 0);

ALTER TABLE application
    ADD COLUMN IF NOT EXISTS parent_application_id INTEGER
        REFERENCES application (application_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_application_parent
    ON application (parent_application_id)
    WHERE parent_application_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5  (from department-isolation script)
-- Department lookup table + has_global_access flag
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS department (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL UNIQUE,
    code       VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO department (name, code) VALUES
    ('Human Resources',        'HR'),
    ('Finance',                'FIN'),
    ('Legal Services',         'LEGAL'),
    ('Information Technology', 'IT'),
    ('Procurement',            'PROC'),
    ('Administration',         'ADMIN'),
    ('Operations',             'OPS'),
    ('Compliance',             'COMP')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS has_global_access BOOLEAN NOT NULL DEFAULT FALSE;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6  (from 005)
-- Rename s3_path → file_path in document and report tables
-- NOT idempotent via standard SQL — guarded with a conditional DO $$ block.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    -- Rename in document table only if s3_path still exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'document' AND column_name = 's3_path'
    ) THEN
        ALTER TABLE document RENAME COLUMN s3_path TO file_path;
    END IF;

    -- Rename in report table only if s3_path still exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'report' AND column_name = 's3_path'
    ) THEN
        ALTER TABLE report RENAME COLUMN s3_path TO file_path;
    END IF;
END
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7  (from 006)
-- Device returns, approval delegation, department budget
-- ─────────────────────────────────────────────────────────────────────────────

-- 7a. DEVICE_RETURN — end-to-end return lifecycle.
CREATE TABLE IF NOT EXISTS device_return (
    return_id         SERIAL PRIMARY KEY,
    contract_id       INTEGER NOT NULL REFERENCES contract(contract_id)   ON DELETE RESTRICT,
    client_user_id    INTEGER NOT NULL REFERENCES client_user(client_user_id) ON DELETE RESTRICT,
    initiated_by      INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE RESTRICT,
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

-- One active return per contract at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_return_per_contract
    ON device_return (contract_id)
    WHERE return_status NOT IN ('Completed', 'Cancelled');

-- 7b. APPROVAL_DELEGATION — temporary authority grant.
CREATE TABLE IF NOT EXISTS approval_delegation (
    delegation_id   SERIAL PRIMARY KEY,
    delegator_id    INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE CASCADE,
    delegate_id     INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE CASCADE,
    start_date      TIMESTAMP WITH TIME ZONE NOT NULL,
    end_date        TIMESTAMP WITH TIME ZONE NOT NULL,
    reason          TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_delegation_dates CHECK (end_date > start_date)
);

-- One active delegation per manager at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_delegation_per_delegator
    ON approval_delegation (delegator_id)
    WHERE is_active = TRUE;

-- 7c. DEPARTMENT_BUDGET — monthly spend ceilings per department per year.
CREATE TABLE IF NOT EXISTS department_budget (
    budget_id        SERIAL PRIMARY KEY,
    department_id    VARCHAR(50) NOT NULL,
    fiscal_year      INTEGER     NOT NULL,
    monthly_ceiling  NUMERIC(10,2) NOT NULL CHECK (monthly_ceiling > 0),
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE RESTRICT,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_dept_year UNIQUE (department_id, fiscal_year)
);


COMMIT;

-- =============================================================================
-- END OF CONSOLIDATED MIGRATIONS
-- =============================================================================
