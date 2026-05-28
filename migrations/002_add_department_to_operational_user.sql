-- =============================================================================
-- Migration 002 — Add department_id to operational_user
-- =============================================================================
-- Managers and Finance users must be scoped to a department so they only
-- review applications from clients in that same department.
-- Admin / MTN_Staff / Approver roles may leave this NULL.
--
-- UP:   psql -U <user> -d <dbname> -f migrations/002_add_department_to_operational_user.sql
-- =============================================================================

BEGIN;

ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS department_id VARCHAR(50);

-- Speed up the join used by the department-scoped queue queries
CREATE INDEX IF NOT EXISTS idx_op_user_department
    ON operational_user (department_id)
    WHERE department_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS idx_op_user_department;
-- ALTER TABLE operational_user DROP COLUMN IF EXISTS department_id;
-- COMMIT;
