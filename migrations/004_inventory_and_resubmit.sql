-- =============================================================================
-- Migration 004 — Device stock tracking + application re-submission lineage
-- =============================================================================
BEGIN;

-- stock_quantity: NULL = unlimited/not tracked, integer = finite stock
ALTER TABLE device_catalog
    ADD COLUMN IF NOT EXISTS stock_quantity INTEGER CHECK (stock_quantity >= 0);

-- Tracks which rejected/cancelled application this one was re-submitted from
ALTER TABLE application
    ADD COLUMN IF NOT EXISTS parent_application_id INTEGER
        REFERENCES application (application_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_application_parent
    ON application (parent_application_id)
    WHERE parent_application_id IS NOT NULL;

COMMIT;

-- DOWN
-- BEGIN;
-- ALTER TABLE application DROP COLUMN IF EXISTS parent_application_id;
-- ALTER TABLE device_catalog DROP COLUMN IF EXISTS stock_quantity;
-- COMMIT;
