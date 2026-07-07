-- Migration 006: Device Returns, Approval Delegation, Department Budget
-- Run on both VPS and local. All statements are idempotent (IF NOT EXISTS).

-- ─── 1. DEVICE RETURN ────────────────────────────────────────────────────────
-- Tracks the full lifecycle of a device being returned at contract end or early
-- termination: Requested → Approved → Collected → Assessed → Completed.

CREATE TABLE IF NOT EXISTS device_return (
    return_id         SERIAL PRIMARY KEY,
    contract_id       INTEGER NOT NULL REFERENCES contract(contract_id) ON DELETE RESTRICT,
    client_user_id    INTEGER NOT NULL REFERENCES client_user(client_user_id) ON DELETE RESTRICT,
    initiated_by      INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE RESTRICT,
    return_status     VARCHAR(50) NOT NULL DEFAULT 'Requested'
        CHECK (return_status IN ('Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled')),
    return_reason     TEXT NOT NULL,
    condition_grade   VARCHAR(5)
        CHECK (condition_grade IN ('A', 'B', 'C', 'D', NULL)),
    condition_notes   TEXT,
    initiated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    collected_at      TIMESTAMP WITH TIME ZONE,
    completed_at      TIMESTAMP WITH TIME ZONE
);

-- Prevent two active (non-Completed/Cancelled) returns for the same contract
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_return_per_contract
    ON device_return (contract_id)
    WHERE return_status NOT IN ('Completed', 'Cancelled');

-- ─── 2. APPROVAL DELEGATION ──────────────────────────────────────────────────
-- Allows a Manager to delegate their approval authority to another operational
-- user for a defined date range (e.g. while on leave).
-- Only one active delegation per delegator is enforced by partial unique index.

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

-- One active delegation per manager at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_delegation_per_delegator
    ON approval_delegation (delegator_id)
    WHERE is_active = TRUE;

-- ─── 3. DEPARTMENT BUDGET ────────────────────────────────────────────────────
-- Stores the monthly device spend ceiling per department per fiscal year.
-- Actual spend is computed at query time from active contracts.

CREATE TABLE IF NOT EXISTS department_budget (
    budget_id        SERIAL PRIMARY KEY,
    department_id    VARCHAR(50) NOT NULL,
    fiscal_year      INTEGER NOT NULL,
    monthly_ceiling  NUMERIC(10,2) NOT NULL CHECK (monthly_ceiling > 0),
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES operational_user(op_user_id) ON DELETE RESTRICT,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_dept_year UNIQUE (department_id, fiscal_year)
);
