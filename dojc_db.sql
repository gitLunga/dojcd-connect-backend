-- PostgreSQL DDL Script generated from ERD

-- Set up a transaction for atomicity
BEGIN;

-- 1. Table: CLIENT_USER
CREATE TABLE client_user (
    client_user_id SERIAL PRIMARY KEY,
    title VARCHAR(50),
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(50),
    region VARCHAR(100),
    persal_id VARCHAR(50) UNIQUE,
    department_id VARCHAR(50),
    user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('Advocate', 'Magistrate')),
    password_hash VARCHAR(255) NOT NULL,
    cognito_id VARCHAR(255) UNIQUE,

    -- New fields
    network_provider VARCHAR(50) 
        CHECK (network_provider IN ('MTN', 'Vodacom', 'Cell_C', 'Telkom', 'Rain')),
    contract_duration_months INTEGER,
    contract_end_date DATE,
    invoice_path VARCHAR(255),
    registration_status VARCHAR(50) 
        DEFAULT 'Pending'
        CHECK (registration_status IN ('Pending', 'Verified', 'Rejected')),
    verification_notes TEXT
	
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);



-- 2. Table: DEVICE_CATALOG
CREATE TABLE device_catalog (
    device_id SERIAL PRIMARY KEY,
    device_name VARCHAR(255) NOT NULL,
    model VARCHAR(255),
    manufacturer VARCHAR(255),
    plan_name VARCHAR(255) NOT NULL,
    plan_details TEXT,
    monthly_cost NUMERIC(10, 2) NOT NULL,
    contract_duration_months INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('Available', 'Discontinued'))
);

-- 3. Table: OPERATIONAL_USER
CREATE TABLE operational_user (
    op_user_id SERIAL PRIMARY KEY,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    user_role VARCHAR(50) NOT NULL CHECK (user_role IN ('Admin', 'MTN_Staff', 'Warehouse', 'Approver')),
    password_hash VARCHAR(255) NOT NULL,
    cognito_id VARCHAR(255) UNIQUE
	
	created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Table: APPLICATION
CREATE TABLE application (
    application_id SERIAL PRIMARY KEY,
    client_user_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,
    application_status VARCHAR(50) NOT NULL CHECK (application_status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
    submission_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    rejection_reason TEXT,
    
    -- Foreign Keys
    CONSTRAINT fk_client_user
        FOREIGN KEY (client_user_id)
        REFERENCES client_user (client_user_id)
        ON DELETE RESTRICT,
    
    CONSTRAINT fk_device_catalog
        FOREIGN KEY (device_id)
        REFERENCES device_catalog (device_id)
        ON DELETE RESTRICT
);

-- 5. Table: DOCUMENT
CREATE TABLE document (
    document_id SERIAL PRIMARY KEY,
    application_id INTEGER NOT NULL,
    client_user_id INTEGER NOT NULL,
    document_type VARCHAR(50) NOT NULL CHECK (document_type IN ('Payslip', 'ID', 'Proof_of_Residence')),
    s3_path VARCHAR(255) NOT NULL,
    upload_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    
    -- Foreign Keys
    CONSTRAINT fk_application
        FOREIGN KEY (application_id)
        REFERENCES application (application_id)
        ON DELETE CASCADE, -- Documents are tied to an application
        
    CONSTRAINT fk_client_user
        FOREIGN KEY (client_user_id)
        REFERENCES client_user (client_user_id)
        ON DELETE RESTRICT
);

-- 6. Table: APPROVAL
CREATE TABLE approval (
    approval_id SERIAL PRIMARY KEY,
    application_id INTEGER UNIQUE NOT NULL, -- 1:1 relationship with application
    approver_op_user_id INTEGER NOT NULL,
    approval_status VARCHAR(50) NOT NULL CHECK (approval_status IN ('Approved', 'Rejected')),
    approval_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes TEXT,
    
    -- Foreign Keys
    CONSTRAINT fk_application
        FOREIGN KEY (application_id)
        REFERENCES application (application_id)
        ON DELETE CASCADE, -- Approval is tied to an application
        
    CONSTRAINT fk_approver
        FOREIGN KEY (approver_op_user_id)
        REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 7. Table: ORDER
CREATE TABLE "order" ( -- "order" is a reserved keyword, so it's quoted
    order_id SERIAL PRIMARY KEY,
    application_id INTEGER UNIQUE NOT NULL, -- 1:1 relationship with application
    mtn_staff_op_user_id INTEGER NOT NULL,
    order_status VARCHAR(50) NOT NULL CHECK (order_status IN ('Processing', 'Dispatched', 'Delivered', 'Cancelled')),
    order_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    warehouse_ref VARCHAR(255),
    
    -- Foreign Keys
    CONSTRAINT fk_application
        FOREIGN KEY (application_id)
        REFERENCES application (application_id)
        ON DELETE CASCADE, -- Order is tied to an application
        
    CONSTRAINT fk_mtn_staff
        FOREIGN KEY (mtn_staff_op_user_id)
        REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 8. Table: REPORT
CREATE TABLE report (
    report_id SERIAL PRIMARY KEY,
    report_name VARCHAR(255) NOT NULL,
    generated_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    s3_path VARCHAR(255) NOT NULL,
    admin_op_user_id INTEGER NOT NULL,
    
    -- Foreign Keys
    CONSTRAINT fk_admin_user
        FOREIGN KEY (admin_op_user_id)
        REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- 9. Table: CONTRACT
CREATE TABLE contract (
    contract_id SERIAL PRIMARY KEY,
    order_id INTEGER UNIQUE NOT NULL, -- 1:1 relationship with order
    device_id INTEGER NOT NULL, -- Actual device delivered
    imei VARCHAR(50) UNIQUE NOT NULL,
    sim_number VARCHAR(50) UNIQUE NOT NULL,
    billing_plan_ref VARCHAR(255),
    activation_date TIMESTAMP WITH TIME ZONE,
    mtn_contract_ref VARCHAR(255) UNIQUE,
    
    -- Foreign Keys
    CONSTRAINT fk_order
        FOREIGN KEY (order_id)
        REFERENCES "order" (order_id)
        ON DELETE CASCADE, -- Contract is tied to an order
        
    CONSTRAINT fk_device_catalog
        FOREIGN KEY (device_id)
        REFERENCES device_catalog (device_id)
        ON DELETE RESTRICT
);

-- 10. Table: DELIVERY
CREATE TABLE delivery (
    delivery_id SERIAL PRIMARY KEY,
    order_id INTEGER UNIQUE NOT NULL, -- 1:1 relationship with order
    warehouse_op_user_id INTEGER NOT NULL,
    courier_name VARCHAR(255),
    tracking_number VARCHAR(255) UNIQUE,
    delivery_address TEXT NOT NULL,
    delivery_status VARCHAR(50) NOT NULL CHECK (delivery_status IN ('Pending', 'In_Transit', 'Delivered', 'Failed')),
    dispatch_date TIMESTAMP WITH TIME ZONE,
    estimated_delivery_date TIMESTAMP WITH TIME ZONE,
    actual_delivery_date TIMESTAMP WITH TIME ZONE,
    
    -- Foreign Keys
    CONSTRAINT fk_order
        FOREIGN KEY (order_id)
        REFERENCES "order" (order_id)
        ON DELETE CASCADE, -- Delivery is tied to an order
        
    CONSTRAINT fk_warehouse_staff
        FOREIGN KEY (warehouse_op_user_id)
        REFERENCES operational_user (op_user_id)
        ON DELETE RESTRICT
);

-- Commit the transaction
COMMIT;
