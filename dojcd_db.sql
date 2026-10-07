-- =============================================================================
-- DOJCD Connect — Full Database Script (all 20 tables, safe to re-run)
-- =============================================================================
-- One file for every developer. Run it on a NEW or an EXISTING database:
--
--     psql -U <user> -d <dbname> -v ON_ERROR_STOP=1 -f dojcd_db.sql
--
-- (or open it in pgAdmin / DataGrip / DBeaver and run it as a script)
--
-- Run it as the same database user the backend connects with (DB_USER in .env),
-- otherwise the tables it adds belong to you and the app cannot use them.
--
--   new database ........ creates every table
--   older database ...... adds whatever is missing: tables, columns, status
--                         values, indexes
--   up-to-date database . nothing visible changes (a few CHECK rules are dropped
--                         and re-created, which takes a brief lock)
--
-- It never drops a table or deletes a row. It runs as ONE transaction, so with
-- ON_ERROR_STOP it either applies completely or not at all.
--
-- It replaces dojc_db.sql (15 tables, out of date), migrations 001-009,
-- migrations/all_migrations.sql, src/scripts/migrate-department-isolation.sql and
-- the "Sample Device Insert script". Do not run those on top of it; they stay in
-- git as history.
--
-- WHEN YOU CHANGE THE SCHEMA
--   Edit THIS file and commit it. A change that only exists in your own local
--   database does not exist for anyone else.
--     new column ........ add it to the CREATE TABLE and ALSO as an
--                         ADD COLUMN IF NOT EXISTS line under that table, so
--                         databases that already have the table get it too
--     changed CHECK ..... change the list in the CREATE TABLE and in the
--                         DROP CONSTRAINT / ADD CONSTRAINT pair under the table
--
-- At the end it lists the tables in the database. You should see at least these
-- 20; anything else was created locally in your own database.
-- =============================================================================

BEGIN;

-- Fail fast instead of waiting forever if another session is holding a table, and
-- keep the "already exists, skipping" notices out of the output (warnings still show).
SET LOCAL lock_timeout = '15s';
SET LOCAL client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- 1. CLIENT_USER
--    Judges and Advocates who apply for mobile devices.
--    registration_status drives the onboarding state machine.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_user (
    client_user_id           SERIAL PRIMARY KEY,
    title                    VARCHAR(50),
    first_name               VARCHAR(255) NOT NULL,
    last_name                VARCHAR(255) NOT NULL,
    email                    VARCHAR(255) UNIQUE NOT NULL,
    phone_number             VARCHAR(50),
    region                   VARCHAR(100),
    persal_id                VARCHAR(50) UNIQUE,
    department_id            VARCHAR(50),            -- stores the department NAME
    user_type                VARCHAR(50) NOT NULL
        CHECK (user_type IN ('Advocate', 'Magistrate')),
    password_hash            VARCHAR(255) NOT NULL,
    cognito_id               VARCHAR(255) UNIQUE,
    network_provider         VARCHAR(50)
        CHECK (network_provider IN ('MTN', 'Vodacom', 'Cell_C', 'Telkom', 'Rain')),
    contract_duration_months INTEGER,
    contract_end_date        DATE,
    invoice_path             VARCHAR(255),
    registration_status      VARCHAR(50) NOT NULL DEFAULT 'Pending'
        CHECK (registration_status IN ('Pending', 'Profile_Completed', 'Verified', 'Rejected', 'Deactivated')),
    verification_notes       TEXT,
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Older databases: 'Deactivated' was added to registration_status (migration 007).
ALTER TABLE client_user DROP CONSTRAINT IF EXISTS client_user_registration_status_check;
ALTER TABLE client_user ADD CONSTRAINT client_user_registration_status_check
    CHECK (registration_status IN ('Pending', 'Profile_Completed', 'Verified', 'Rejected', 'Deactivated'));

-- -----------------------------------------------------------------------------
-- 2. DEVICE_CATALOG
--    Reference table of devices and MTN plans available for allocation.
--    stock_quantity: NULL = not tracked, a number = finite stock.
-- -----------------------------------------------------------------------------
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
    stock_quantity           INTEGER CHECK (stock_quantity >= 0),
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Older databases (migration 004):
ALTER TABLE device_catalog ADD COLUMN IF NOT EXISTS stock_quantity INTEGER CHECK (stock_quantity >= 0);

-- -----------------------------------------------------------------------------
-- 3. OPERATIONAL_USER
--    Internal staff: Admin, Manager, Finance, MTN_Staff, Approver.
--    is_deleted / deleted_at enable soft-delete so approval authorship is
--    preserved even after an employee leaves.
--    has_global_access lets a Manager / Finance user see every department.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_user (
    op_user_id           SERIAL PRIMARY KEY,
    title                VARCHAR(20),
    first_name           VARCHAR(255) NOT NULL,
    last_name            VARCHAR(255) NOT NULL,
    email                VARCHAR(255) UNIQUE NOT NULL,
    user_role            VARCHAR(50) NOT NULL
        CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance')),
    department_id        VARCHAR(50),                -- stores the department NAME
    password_hash        VARCHAR(255) NOT NULL,
    cognito_id           VARCHAR(255) UNIQUE,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    is_super_admin       BOOLEAN NOT NULL DEFAULT false,
    has_global_access    BOOLEAN NOT NULL DEFAULT false,
    is_deleted           BOOLEAN NOT NULL DEFAULT false,
    deleted_at           TIMESTAMP WITH TIME ZONE,
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Older databases (migrations 001 and 002, plus the department-isolation script):
ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS is_deleted        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS department_id     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS has_global_access BOOLEAN NOT NULL DEFAULT false;

-- Older databases: the Manager and Finance roles were added (migration 001).
ALTER TABLE operational_user DROP CONSTRAINT IF EXISTS operational_user_user_role_check;
ALTER TABLE operational_user ADD CONSTRAINT operational_user_user_role_check
    CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'));

CREATE INDEX IF NOT EXISTS idx_operational_user_active
    ON operational_user (is_deleted)
    WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_operational_user_department
    ON operational_user (department_id)
    WHERE department_id IS NOT NULL;

-- Older databases: migration 002 created the same index under another name.
DROP INDEX IF EXISTS idx_op_user_department;

-- -----------------------------------------------------------------------------
-- 4. APPLICATION
--    A client's request for a specific device/plan.
--    Status flows: Pending → Pending_Finance → Approved
--                         ↘ Rejected / Cancelled at any stage
--    parent_application_id links a re-submission to the application it replaces.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application (
    application_id         SERIAL PRIMARY KEY,
    client_user_id         INTEGER NOT NULL,
    device_id              INTEGER NOT NULL,
    application_status     VARCHAR(50) NOT NULL
        CHECK (application_status IN (
            'Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled'
        )),
    submission_date        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_updated           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rejection_reason       TEXT,
    parent_application_id  INTEGER,

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

-- Older databases (migration 004):
ALTER TABLE application
    ADD COLUMN IF NOT EXISTS parent_application_id INTEGER
        REFERENCES application (application_id) ON DELETE SET NULL;

-- Older databases: 'Pending_Finance' was added to application_status (migration 001).
ALTER TABLE application DROP CONSTRAINT IF EXISTS application_application_status_check;
ALTER TABLE application ADD CONSTRAINT application_application_status_check
    CHECK (application_status IN ('Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled'));

CREATE INDEX IF NOT EXISTS idx_application_parent
    ON application (parent_application_id)
    WHERE parent_application_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. NOTIFICATION
--    In-app notifications for both client and operational users.
--    Polymorphic via user_id + user_type (no FK enforced at DB level).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
    notification_id SERIAL PRIMARY KEY,
    user_id         INTEGER      NOT NULL,
    user_type       VARCHAR(20)  NOT NULL CHECK (user_type IN ('Client', 'Operational')),
    title           VARCHAR(255) NOT NULL,
    message         TEXT         NOT NULL,
    is_read         BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 6. DOCUMENT
--    Supporting documents uploaded during profile completion.
--    application_id is nullable — documents are uploaded at profile-complete
--    time, before an application exists.
-- -----------------------------------------------------------------------------
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

-- Older databases: s3_path was renamed to file_path (migration 005).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'document' AND column_name = 's3_path') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'document' AND column_name = 'file_path') THEN
            RAISE EXCEPTION 'document has BOTH s3_path and file_path: copy s3_path into file_path, drop s3_path, then run this again';
        END IF;
        ALTER TABLE document RENAME COLUMN s3_path TO file_path;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 7. APPROVAL
--    One row per stage per application (manager row + finance row = 2 rows).
--    application_id is NOT UNIQUE here — the two-stage workflow deliberately
--    produces two rows for a fully-approved application.
--    approval_stage identifies which workflow step the row belongs to.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval (
    approval_id         SERIAL PRIMARY KEY,
    application_id      INTEGER     NOT NULL,
    approver_op_user_id INTEGER     NOT NULL,
    approval_stage      VARCHAR(20)
        CHECK (approval_stage IN ('manager', 'finance', 'admin')),
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

-- Older databases (migration 001): application_id used to be UNIQUE, which blocks
-- the second (finance) approval row, and approval_stage did not exist.
ALTER TABLE approval DROP CONSTRAINT IF EXISTS approval_application_id_key;
ALTER TABLE approval
    ADD COLUMN IF NOT EXISTS approval_stage VARCHAR(20)
        CHECK (approval_stage IN ('manager', 'finance', 'admin'));

CREATE INDEX IF NOT EXISTS idx_approval_application_stage
    ON approval (application_id, approval_stage);

-- -----------------------------------------------------------------------------
-- 8. ORDER  (quoted because ORDER is a reserved SQL keyword)
--    Created by admin once the application is fully approved.
--    1:1 with application.
-- -----------------------------------------------------------------------------
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

-- Older databases:
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS notes TEXT;

-- -----------------------------------------------------------------------------
-- 9. REPORT
--     Stores generated report metadata (PDF/CSV file paths).
-- -----------------------------------------------------------------------------
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

-- Older databases: s3_path was renamed to file_path (migration 005).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'report' AND column_name = 's3_path') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'report' AND column_name = 'file_path') THEN
            RAISE EXCEPTION 'report has BOTH s3_path and file_path: copy s3_path into file_path, drop s3_path, then run this again';
        END IF;
        ALTER TABLE report RENAME COLUMN s3_path TO file_path;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 10. CONTRACT
--     Activated once the device is delivered.  Stores IMEI, SIM, and the MTN
--     contract reference.  1:1 with order.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 11. DELIVERY
--     Courier tracking for dispatched orders.  1:1 with order.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery (
    delivery_id               SERIAL PRIMARY KEY,
    order_id                  INTEGER UNIQUE NOT NULL,
    warehouse_op_user_id      INTEGER NOT NULL,
    courier_name              VARCHAR(255),
    tracking_number           VARCHAR(255) UNIQUE,
    delivery_address          TEXT NOT NULL,
    delivery_status           VARCHAR(50) NOT NULL
        CHECK (delivery_status IN ('Pending', 'In_Transit', 'Delivered', 'Failed')),
    dispatch_date             TIMESTAMP WITH TIME ZONE,
    estimated_delivery_date   TIMESTAMP WITH TIME ZONE,
    actual_delivery_date      TIMESTAMP WITH TIME ZONE,

    CONSTRAINT fk_delivery_order
        FOREIGN KEY (order_id) REFERENCES "order" (order_id)
        ON DELETE CASCADE,

    CONSTRAINT fk_delivery_warehouse
        FOREIGN KEY (warehouse_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- 12. AUDIT_LOG
--     Immutable record of every significant action in the system.
--     Written inside the same DB transaction as the event it describes.
--     Never updated or deleted — append-only.
--     The app writes actor_type in both spellings ('Operational' from most
--     services, 'operational_user' from the budget and delegation services),
--     so both are allowed.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    log_id      BIGSERIAL PRIMARY KEY,
    actor_id    INTEGER      NOT NULL,
    actor_type  VARCHAR(20)  NOT NULL
        CHECK (actor_type IN ('Client', 'Operational', 'System', 'client_user', 'operational_user', 'system')),
    action      VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id   INTEGER,
    old_value   JSONB,
    new_value   JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Older databases: the allowed actor_type values grew.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
    CHECK (actor_type IN ('Client', 'Operational', 'System', 'client_user', 'operational_user', 'system'));

CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (actor_id, actor_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- 13. REFRESH_TOKEN
--     Stores hashed refresh tokens for the JWT auth flow.
--     revoked_at enables immediate invalidation on logout.
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

CREATE INDEX IF NOT EXISTS idx_refresh_token_user ON refresh_token (user_id, user_type);
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_token (token_hash);

-- -----------------------------------------------------------------------------
-- 14. PASSWORD_RESET_TOKEN
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 15. LOGIN_ATTEMPT
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempt (
    attempt_id BIGSERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    ip_address INET,
    success    BOOLEAN      NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempt_email ON login_attempt (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip    ON login_attempt (ip_address, created_at DESC);

-- -----------------------------------------------------------------------------
-- 16. DEPARTMENT
--    Lookup table of the DoJ&CD branches that clients register under.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS department (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL UNIQUE,
    code       VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- The 10 DoJ&CD branches. These names must match the DEPARTMENTS array in
-- src/screens/Auth/ClientRegisterScreen.jsx of the client web repo (DOJCD-Client-Web)
-- exactly, because client_user.department_id stores the name as text.
-- Existing rows are left alone. A branch an Admin deleted comes back on the next
-- run, and databases that ran src/scripts/migrate-department-isolation.sql keep
-- its 8 generic departments (remove them under Admin > Departments if unwanted).
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

-- -----------------------------------------------------------------------------
-- 17. DEVICE_RETURN
--     Return lifecycle: Requested → Approved → Collected → Assessed → Completed
--     (or Cancelled).  Raised either by staff or by the client themselves:
--       initiated_by_type = 'Operational'  initiated_by = the staff op_user_id
--       initiated_by_type = 'Client'       initiated_by IS NULL (client_user_id says who)
--     visible_to_client: the department's grade and notes are shown to the
--     client only when this is true. Returns created before it existed stay hidden.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_return (
    return_id         SERIAL PRIMARY KEY,
    contract_id       INTEGER NOT NULL REFERENCES contract (contract_id)       ON DELETE RESTRICT,
    client_user_id    INTEGER NOT NULL REFERENCES client_user (client_user_id) ON DELETE RESTRICT,
    initiated_by      INTEGER REFERENCES operational_user (op_user_id)         ON DELETE RESTRICT,
    initiated_by_type VARCHAR(20) NOT NULL DEFAULT 'Operational',
    return_status     VARCHAR(50) NOT NULL DEFAULT 'Requested'
        CHECK (return_status IN ('Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled')),
    return_reason     TEXT NOT NULL,
    condition_grade   VARCHAR(5)
        CHECK (condition_grade IN ('A', 'B', 'C', 'D')),
    condition_notes   TEXT,
    initiated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at       TIMESTAMP WITH TIME ZONE,
    collected_at      TIMESTAMP WITH TIME ZONE,
    assessed_at       TIMESTAMP WITH TIME ZONE,
    completed_at      TIMESTAMP WITH TIME ZONE,
    cancelled_at      TIMESTAMP WITH TIME ZONE,
    visible_to_client BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT chk_device_return_initiator CHECK (
        (initiated_by_type = 'Operational' AND initiated_by IS NOT NULL)
     OR (initiated_by_type = 'Client'      AND initiated_by IS NULL)
    )
);

-- Older databases (migrations 006 and 009): a client is not an operational user,
-- so initiated_by must allow NULL; the extra timeline columns did not exist.
ALTER TABLE device_return ALTER COLUMN initiated_by DROP NOT NULL;
ALTER TABLE device_return
    ADD COLUMN IF NOT EXISTS initiated_by_type VARCHAR(20) NOT NULL DEFAULT 'Operational',
    ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS assessed_at       TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS visible_to_client BOOLEAN NOT NULL DEFAULT false;
-- (Migration 006 listed NULL among the allowed grades, which made the rule accept any value.)
ALTER TABLE device_return DROP CONSTRAINT IF EXISTS device_return_condition_grade_check;
ALTER TABLE device_return ADD CONSTRAINT device_return_condition_grade_check
    CHECK (condition_grade IN ('A', 'B', 'C', 'D'));
ALTER TABLE device_return DROP CONSTRAINT IF EXISTS chk_device_return_initiator;
ALTER TABLE device_return ADD CONSTRAINT chk_device_return_initiator CHECK (
    (initiated_by_type = 'Operational' AND initiated_by IS NOT NULL)
 OR (initiated_by_type = 'Client'      AND initiated_by IS NULL)
);

-- At most one return in progress per contract.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_return_per_contract
    ON device_return (contract_id)
    WHERE return_status NOT IN ('Completed', 'Cancelled');

-- -----------------------------------------------------------------------------
-- 18. APPROVAL_DELEGATION
--     Lets a Manager delegate approval authority to another operational user
--     for a date range (e.g. while on leave).
-- -----------------------------------------------------------------------------
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

-- One active delegation per manager at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_delegation_per_delegator
    ON approval_delegation (delegator_id)
    WHERE is_active = TRUE;

-- -----------------------------------------------------------------------------
-- 19. DEPARTMENT_BUDGET
--     Monthly device spend ceiling per department per fiscal year.
--     Actual spend is computed at query time from active contracts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS department_budget (
    budget_id        SERIAL PRIMARY KEY,
    department_id    VARCHAR(50) NOT NULL,
    fiscal_year      INTEGER NOT NULL,
    monthly_ceiling  NUMERIC(10, 2) NOT NULL CHECK (monthly_ceiling > 0),
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES operational_user (op_user_id) ON DELETE RESTRICT,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_dept_year UNIQUE (department_id, fiscal_year)
);

-- -----------------------------------------------------------------------------
-- 20. STORAGE_FILES
--     Upload metadata for src/config/pgStorage.js. The running app currently keeps
--     uploads on disk (src/config/localStorage.js), so nothing writes here yet;
--     it is kept so every database has the same tables.
-- -----------------------------------------------------------------------------
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

COMMIT;

-- =============================================================================
-- OPTIONAL: sample devices for LOCAL TESTING ONLY (never on production).
-- Uncomment and run. A device + plan that already exists is skipped, so running it
-- twice is harmless. (The same 8 devices are in the "Sample Device Insert script".)
-- =============================================================================
-- INSERT INTO device_catalog
--     (device_name, model, manufacturer, plan_name, plan_details,
--      monthly_cost, contract_duration_months, status)
-- SELECT v.*
--   FROM (VALUES
--     ('Samsung Galaxy A14',    'SM-A145F', 'Samsung', 'MTN Smart 5GB',    '5GB data, Unlimited calls, 100 SMS',        299.99, 24, 'active'),
--     ('iPhone 13',             'A2631',    'Apple',   'MTN Premium 10GB', '10GB data, Unlimited calls, Unlimited SMS', 899.99, 24, 'active'),
--     ('Huawei Nova Y70',       'JLN-LX1',  'Huawei',  'MTN Basic 3GB',    '3GB data, 100 minutes, 50 SMS',             199.99, 24, 'active'),
--     ('Nokia G21',             'TA-1406',  'Nokia',   'MTN Value 2GB',    '2GB data, 60 minutes, 30 SMS',              149.99, 24, 'active'),
--     ('Samsung Galaxy Tab A8', 'SM-X205',  'Samsung', 'MTN Tablet 15GB',  '15GB data, Unlimited Wi-Fi calling',        399.99, 24, 'active'),
--     ('Huawei MatePad T10',    'AGS3-L09', 'Huawei',  'MTN Tablet 10GB',  '10GB data, Unlimited Wi-Fi calling',        349.99, 24, 'active'),
--     ('MTN 5G Router',         'MR1000',   'MTN',     'MTN Home 100GB',   '100GB data, Unlimited off-peak',            499.99, 24, 'active'),
--     ('Huawei 4G Router',      'B535-232', 'Huawei',  'MTN Office 50GB',  '50GB data, 32 devices',                     349.99, 24, 'active')
--   ) AS v(device_name, model, manufacturer, plan_name, plan_details,
--          monthly_cost, contract_duration_months, status)
--  WHERE NOT EXISTS (SELECT 1 FROM device_catalog d
--                     WHERE d.device_name = v.device_name AND d.plan_name = v.plan_name);

-- =============================================================================
-- CHECK: you should see at least these 20 tables (anything else is local to your database).
-- =============================================================================
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
 ORDER BY table_name;
