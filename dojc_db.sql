-- =============================================================================
-- DOJCD Connect — Full Database Schema (canonical, fresh-install version)
-- =============================================================================
-- For existing databases run migrations/001_fix_schema.sql instead.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. CLIENT_USER
--    Judges and Advocates who apply for mobile devices.
--    registration_status drives the onboarding state machine.
-- -----------------------------------------------------------------------------
CREATE TABLE client_user (
    client_user_id           SERIAL PRIMARY KEY,
    title                    VARCHAR(50),
    first_name               VARCHAR(255) NOT NULL,
    last_name                VARCHAR(255) NOT NULL,
    email                    VARCHAR(255) UNIQUE NOT NULL,
    phone_number             VARCHAR(50),
    region                   VARCHAR(100),
    persal_id                VARCHAR(50) UNIQUE,
    department_id            VARCHAR(50),
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
        CHECK (registration_status IN ('Pending', 'Profile_Completed', 'Verified', 'Rejected')),
    verification_notes       TEXT,
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 2. DEVICE_CATALOG
--    Reference table of devices and MTN plans available for allocation.
-- -----------------------------------------------------------------------------
CREATE TABLE device_catalog (
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

-- -----------------------------------------------------------------------------
-- 3. OPERATIONAL_USER
--    Internal staff: Admin, Manager, Finance, MTN_Staff, Approver.
--    is_deleted / deleted_at enable soft-delete so approval authorship is
--    preserved even after an employee leaves.
-- -----------------------------------------------------------------------------
CREATE TABLE operational_user (
    op_user_id           SERIAL PRIMARY KEY,
    title                VARCHAR(20),
    first_name           VARCHAR(255) NOT NULL,
    last_name            VARCHAR(255) NOT NULL,
    email                VARCHAR(255) UNIQUE NOT NULL,
    user_role            VARCHAR(50) NOT NULL
        CHECK (user_role IN ('Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance')),
    department_id        VARCHAR(50),
    password_hash        VARCHAR(255) NOT NULL,
    cognito_id           VARCHAR(255) UNIQUE,
    must_change_password BOOLEAN NOT NULL DEFAULT true,
    is_super_admin       BOOLEAN NOT NULL DEFAULT false,
    is_deleted           BOOLEAN NOT NULL DEFAULT false,
    deleted_at           TIMESTAMP WITH TIME ZONE,
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_operational_user_active
    ON operational_user (is_deleted)
    WHERE is_deleted = false;

CREATE INDEX idx_operational_user_department
    ON operational_user (department_id)
    WHERE department_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. APPLICATION
--    A client's request for a specific device/plan.
--    Status flows: Pending → Pending_Finance → Approved
--                         ↘ Rejected / Cancelled at any stage
-- -----------------------------------------------------------------------------
CREATE TABLE application (
    application_id     SERIAL PRIMARY KEY,
    client_user_id     INTEGER NOT NULL,
    device_id          INTEGER NOT NULL,
    application_status VARCHAR(50) NOT NULL
        CHECK (application_status IN (
            'Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled'
        )),
    submission_date         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_updated            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    rejection_reason        TEXT,
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

CREATE INDEX idx_application_parent
    ON application (parent_application_id)
    WHERE parent_application_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. NOTIFICATION
--    In-app notifications for both client and operational users.
--    Polymorphic via user_id + user_type (no FK enforced at DB level).
-- -----------------------------------------------------------------------------
CREATE TABLE notification (
    notification_id SERIAL PRIMARY KEY,
    user_id         INTEGER     NOT NULL,
    user_type       VARCHAR(20) NOT NULL CHECK (user_type IN ('Client', 'Operational')),
    title           VARCHAR(255) NOT NULL,
    message         TEXT NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 6. DOCUMENT
--    Supporting documents uploaded during profile completion.
--    application_id is nullable — documents are uploaded at profile-complete
--    time, before an application exists.
-- -----------------------------------------------------------------------------
CREATE TABLE document (
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

-- -----------------------------------------------------------------------------
-- 7. APPROVAL
--    One row per stage per application (manager row + finance row = 2 rows).
--    application_id is NOT UNIQUE here — the two-stage workflow deliberately
--    produces two rows for a fully-approved application.
--    approval_stage identifies which workflow step the row belongs to.
-- -----------------------------------------------------------------------------
CREATE TABLE approval (
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

CREATE INDEX idx_approval_application_stage
    ON approval (application_id, approval_stage);

-- -----------------------------------------------------------------------------
-- 8. ORDER  (quoted because ORDER is a reserved SQL keyword)
--    Created by admin once the application is fully approved.
--    1:1 with application.
-- -----------------------------------------------------------------------------
CREATE TABLE "order" (
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

-- -----------------------------------------------------------------------------
-- 9. REPORT
--    Stores generated report metadata (PDF/CSV file paths).
-- -----------------------------------------------------------------------------
CREATE TABLE report (
    report_id        SERIAL PRIMARY KEY,
    report_name      VARCHAR(255) NOT NULL,
    generated_date   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    file_path        VARCHAR(255) NOT NULL,
    admin_op_user_id INTEGER NOT NULL,

    CONSTRAINT fk_report_admin
        FOREIGN KEY (admin_op_user_id) REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- 10. CONTRACT
--     Activated once the device is delivered.  Stores IMEI, SIM, and the MTN
--     contract reference.  1:1 with order.
-- -----------------------------------------------------------------------------
CREATE TABLE contract (
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
CREATE TABLE delivery (
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
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
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

CREATE INDEX idx_audit_entity  ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_actor   ON audit_log (actor_id, actor_type, created_at DESC);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- -----------------------------------------------------------------------------
-- 13. REFRESH_TOKEN
--     Stores hashed refresh tokens for the JWT auth flow.
--     revoked_at enables immediate invalidation on logout.
-- -----------------------------------------------------------------------------
CREATE TABLE refresh_token (
    token_id   SERIAL PRIMARY KEY,
    user_id    INTEGER     NOT NULL,
    user_type  VARCHAR(20) NOT NULL
        CHECK (user_type IN ('Client', 'Operational')),
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_token_user ON refresh_token (user_id, user_type);
CREATE INDEX idx_refresh_token_hash ON refresh_token (token_hash);

-- -----------------------------------------------------------------------------
-- 14. PASSWORD_RESET_TOKEN
-- -----------------------------------------------------------------------------
CREATE TABLE password_reset_token (
    token_id   SERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    user_type  VARCHAR(20)  NOT NULL
        CHECK (user_type IN ('Client', 'Operational')),
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at    TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prt_email ON password_reset_token (email, created_at DESC);
CREATE INDEX idx_prt_hash  ON password_reset_token (token_hash);

-- -----------------------------------------------------------------------------
-- 15. LOGIN_ATTEMPT
-- -----------------------------------------------------------------------------
CREATE TABLE login_attempt (
    attempt_id BIGSERIAL PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    ip_address INET,
    success    BOOLEAN      NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_login_attempt_email ON login_attempt (email, created_at DESC);
CREATE INDEX idx_login_attempt_ip    ON login_attempt (ip_address, created_at DESC);

COMMIT;
