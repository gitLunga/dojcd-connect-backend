-- =============================================================================
-- DOJCD Connect — reference / sample data  (idempotent: safe to re-run)
-- =============================================================================
-- Reference data only. No users, no passwords, no applications.
--   psql -d <dbname> -v ON_ERROR_STOP=1 -f database/seed.sql     (or setup.sh --seed)
-- =============================================================================

BEGIN;

-- DoJ&CD department branches that clients register under. These names must
-- match the DEPARTMENTS array in DOJCD-Client-Web/src/screens/Auth/
-- ClientRegisterScreen.jsx exactly, because client_user.department_id stores
-- the department name as text. (Was migrations/008_seed_doj_departments.sql.)
INSERT INTO department (name, code) VALUES
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
ON CONFLICT (name) DO NOTHING;

-- Sample devices (was the root-level "Sample Device Insert script").
-- Inserted only if a device with the same name + plan is not already there.
INSERT INTO device_catalog
    (device_name, model, manufacturer, plan_name, plan_details,
     monthly_cost, contract_duration_months, status)
SELECT v.*
  FROM (VALUES
    ('Samsung Galaxy A14',    'SM-A145F', 'Samsung', 'MTN Smart 5GB',     '5GB data, Unlimited calls, 100 SMS',          299.99, 24, 'active'),
    ('iPhone 13',             'A2631',    'Apple',   'MTN Premium 10GB',  '10GB data, Unlimited calls, Unlimited SMS',   899.99, 24, 'active'),
    ('Huawei Nova Y70',       'JLN-LX1',  'Huawei',  'MTN Basic 3GB',     '3GB data, 100 minutes, 50 SMS',               199.99, 24, 'active'),
    ('Nokia G21',             'TA-1406',  'Nokia',   'MTN Value 2GB',     '2GB data, 60 minutes, 30 SMS',                149.99, 24, 'active'),
    ('Samsung Galaxy Tab A8', 'SM-X205',  'Samsung', 'MTN Tablet 15GB',   '15GB data, Unlimited Wi-Fi calling',          399.99, 24, 'active'),
    ('Huawei MatePad T10',    'AGS3-L09', 'Huawei',  'MTN Tablet 10GB',   '10GB data, Unlimited Wi-Fi calling',          349.99, 24, 'active'),
    ('MTN 5G Router',         'MR1000',   'MTN',     'MTN Home 100GB',    '100GB data, Unlimited off-peak',              499.99, 24, 'active'),
    ('Huawei 4G Router',      'B535-232', 'Huawei',  'MTN Office 50GB',   '50GB data, 32 devices',                       349.99, 24, 'active')
  ) AS v(device_name, model, manufacturer, plan_name, plan_details,
         monthly_cost, contract_duration_months, status)
 WHERE NOT EXISTS (
        SELECT 1 FROM device_catalog d
         WHERE d.device_name = v.device_name AND d.plan_name = v.plan_name);

COMMIT;
