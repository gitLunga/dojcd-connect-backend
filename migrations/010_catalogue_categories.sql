-- Migration 010: categories for the catalogue
--
-- The catalogue was only ever mobile phones. Items now belong to a category (Mobile Phones, Tablets,
-- Laptops & Computers, Routers & MiFi, Data & Connectivity, Accessories, Other Services), so other kinds of
-- device and service can be offered, grouped and filtered. Admins can add, rename, reorder and switch off categories.
--
--   requires_hardware_details  true  -> items must have a model and a manufacturer (phones, laptops...)
--                              false -> they need not (a data package, a service)
--   is_active                  false -> the category and its items are hidden from clients and cannot be applied for
--
-- Every existing item becomes a Mobile Phone. The column default keeps old inserts working (the sample-device
-- script, manual SQL, an older backend that does not know about categories): they land in Mobile Phones.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS device_category (
    category_id               SERIAL PRIMARY KEY,
    name                      VARCHAR(100) NOT NULL,
    description               TEXT,
    requires_hardware_details BOOLEAN NOT NULL DEFAULT true,
    sort_order                INTEGER NOT NULL DEFAULT 0,
    is_active                 BOOLEAN NOT NULL DEFAULT true,
    created_at                TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_category_name ON device_category (lower(name));

INSERT INTO device_category (name, description, requires_hardware_details, sort_order) VALUES
    ('Mobile Phones',       'Smartphones and feature phones on contract',                          true,  10),
    ('Tablets',             'Tablets and e-readers',                                               true,  20),
    ('Laptops & Computers', 'Laptops, notebooks and desktop computers',                            true,  30),
    ('Routers & MiFi',      'Mobile routers, MiFi devices and Wi-Fi hotspots',                     true,  40),
    ('Data & Connectivity', 'SIM cards and data bundles',                                          false, 50),
    ('Accessories',         'Cases, chargers, headsets and other add-ons',                         true,  60),
    ('Other Services',      'Any other service or package offered through the Department',         false, 70)
ON CONFLICT (lower(name)) DO NOTHING;

-- The category new items land in when none is chosen.
CREATE OR REPLACE FUNCTION default_device_category_id() RETURNS INTEGER
    LANGUAGE sql STABLE AS
$$ SELECT category_id FROM device_category WHERE lower(name) = 'mobile phones' ORDER BY category_id LIMIT 1 $$;

ALTER TABLE device_catalog ADD COLUMN IF NOT EXISTS category_id INTEGER;
UPDATE device_catalog SET category_id = default_device_category_id() WHERE category_id IS NULL;
ALTER TABLE device_catalog ALTER COLUMN category_id SET DEFAULT default_device_category_id();
ALTER TABLE device_catalog ALTER COLUMN category_id SET NOT NULL;

ALTER TABLE device_catalog DROP CONSTRAINT IF EXISTS device_catalog_category_fk;
ALTER TABLE device_catalog
    ADD CONSTRAINT device_catalog_category_fk FOREIGN KEY (category_id) REFERENCES device_category (category_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_device_catalog_category ON device_catalog (category_id);

COMMIT;
