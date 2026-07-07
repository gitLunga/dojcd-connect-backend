-- Department isolation migration
-- Run once against your PostgreSQL database.

-- 1. Proper department lookup table
CREATE TABLE IF NOT EXISTS department (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL UNIQUE,
    code       VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed common government department names
INSERT INTO department (name, code) VALUES
    ('Human Resources',             'HR'),
    ('Finance',                     'FIN'),
    ('Legal Services',              'LEGAL'),
    ('Information Technology',      'IT'),
    ('Procurement',                 'PROC'),
    ('Administration',              'ADMIN'),
    ('Operations',                  'OPS'),
    ('Compliance',                  'COMP')
ON CONFLICT (name) DO NOTHING;

-- 2. Global-access flag on operational users
--    Managers / Finance without this flag see only their own department's applications.
--    Admin can grant this to allow cross-department visibility.
ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS has_global_access BOOLEAN NOT NULL DEFAULT FALSE;
