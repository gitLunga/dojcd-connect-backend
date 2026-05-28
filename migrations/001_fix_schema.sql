-- =============================================================================
-- Migration 001 — Fix schema mismatches & add Phase 1 tables
-- =============================================================================
-- Run this script against your existing database.
-- It is safe to run on a database that already has some of these changes
-- applied, because every statement uses IF EXISTS / IF NOT EXISTS guards.
--
-- UP:   psql -U <user> -d <dbname> -f migrations/001_fix_schema.sql
-- DOWN: uncomment and run the DOWN block at the bottom of this file.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. APPROVAL TABLE
--    Problem: application_id was declared UNIQUE, enforcing a 1:1 relationship.
--    The two-stage approval workflow (manager → finance) inserts TWO rows per
--    application, so the UNIQUE constraint causes the second INSERT to fail.
--    Fix: drop the implicit unique constraint; keep the foreign key.
--    Add: approval_stage column so each row is identifiable by stage.
-- -----------------------------------------------------------------------------

ALTER TABLE approval
    DROP CONSTRAINT IF EXISTS approval_application_id_key;

ALTER TABLE approval
    ADD COLUMN IF NOT EXISTS approval_stage VARCHAR(20)
        CHECK (approval_stage IN ('manager', 'finance', 'admin'));

-- Index to make per-stage lookups fast (used heavily by approver queue queries)
CREATE INDEX IF NOT EXISTS idx_approval_application_stage
    ON approval (application_id, approval_stage);

-- -----------------------------------------------------------------------------
-- 2. APPLICATION — application_status CHECK
--    Problem: CHECK only listed ('Pending','Approved','Rejected','Cancelled').
--    The manager-approve action sets status to 'Pending_Finance', which violates
--    the constraint and prevents the row from being written.
-- -----------------------------------------------------------------------------

ALTER TABLE application
    DROP CONSTRAINT IF EXISTS application_application_status_check;

ALTER TABLE application
    ADD CONSTRAINT application_application_status_check
        CHECK (application_status IN (
            'Pending',
            'Pending_Finance',
            'Approved',
            'Rejected',
            'Cancelled'
        ));

-- -----------------------------------------------------------------------------
-- 3. OPERATIONAL_USER — user_role CHECK
--    Problem: CHECK only listed ('Admin','MTN_Staff','Approver').
--    The codebase creates and queries 'Manager' and 'Finance' role users.
--    These INSERTs fail silently or loudly depending on the DB state.
-- -----------------------------------------------------------------------------

ALTER TABLE operational_user
    DROP CONSTRAINT IF EXISTS operational_user_user_role_check;

ALTER TABLE operational_user
    ADD CONSTRAINT operational_user_user_role_check
        CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'));

-- -----------------------------------------------------------------------------
-- 4. OPERATIONAL_USER — soft delete columns
--    Hard DELETE destroys the authorship chain on approval records.
--    is_deleted + deleted_at allows the record to be hidden while keeping FKs.
-- -----------------------------------------------------------------------------

ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Index so "active user" lookups stay fast
CREATE INDEX IF NOT EXISTS idx_operational_user_active
    ON operational_user (is_deleted)
    WHERE is_deleted = false;

-- -----------------------------------------------------------------------------
-- 5. AUDIT_LOG — immutable activity trail
--    Records every significant actor action with before/after state.
--    Written inside the same transaction as the business operation it logs.
--    BIGSERIAL because audit tables grow quickly in government workloads.
-- -----------------------------------------------------------------------------

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

-- Composite index: find all events on a specific record (e.g. application #42)
CREATE INDEX IF NOT EXISTS idx_audit_entity
    ON audit_log (entity_type, entity_id);

-- Composite index: find all actions by a specific user, newest first
CREATE INDEX IF NOT EXISTS idx_audit_actor
    ON audit_log (actor_id, actor_type, created_at DESC);

-- Time-range queries (dashboard: events in last 30 days)
CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- 6. REFRESH_TOKEN — JWT refresh token store
--    Short-lived access tokens (15 min) are paired with long-lived refresh
--    tokens (7 days) stored here.  revoked_at allows instant token revocation
--    on logout without waiting for expiry.
-- -----------------------------------------------------------------------------

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

-- Hash lookup used on every token refresh request — must be fast
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash
    ON refresh_token (token_hash);

-- -----------------------------------------------------------------------------
-- 7. LOGIN_ATTEMPT — brute-force detection
--    Every login attempt (success or failure) is recorded so the auth layer
--    can lock an account after N consecutive failures within a time window.
--    BIGSERIAL because this table accumulates a row per login across all users.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS login_attempt (
    attempt_id BIGSERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    ip_address INET,
    success    BOOLEAN      NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Used to count recent failures per email (account lockout check)
CREATE INDEX IF NOT EXISTS idx_login_attempt_email
    ON login_attempt (email, created_at DESC);

-- Used to detect IP-level flooding across multiple accounts
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip
    ON login_attempt (ip_address, created_at DESC);

COMMIT;


-- =============================================================================
-- DOWN MIGRATION
-- =============================================================================
-- Uncomment and run this block to fully revert migration 001.
--
-- WARNING: Restoring approval_application_id_key UNIQUE will fail if more than
-- one approval row exists for the same application_id (i.e., any application
-- that has gone through both manager and finance stages).  Manually remove
-- the duplicate rows or accept that the DOWN is destructive in that scenario.
-- =============================================================================

-- BEGIN;
--
-- DROP TABLE IF EXISTS login_attempt;
-- DROP TABLE IF EXISTS refresh_token;
-- DROP TABLE IF EXISTS audit_log;
--
-- ALTER TABLE operational_user
--     DROP COLUMN IF EXISTS is_deleted,
--     DROP COLUMN IF EXISTS deleted_at;
--
-- ALTER TABLE operational_user
--     DROP CONSTRAINT IF EXISTS operational_user_user_role_check;
-- ALTER TABLE operational_user
--     ADD CONSTRAINT operational_user_user_role_check
--         CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver'));
--
-- ALTER TABLE application
--     DROP CONSTRAINT IF EXISTS application_application_status_check;
-- ALTER TABLE application
--     ADD CONSTRAINT application_application_status_check
--         CHECK (application_status IN ('Pending', 'Approved', 'Rejected', 'Cancelled'));
--
-- ALTER TABLE approval
--     DROP COLUMN IF EXISTS approval_stage;
-- ALTER TABLE approval
--     ADD CONSTRAINT approval_application_id_key UNIQUE (application_id);
--
-- COMMIT;
