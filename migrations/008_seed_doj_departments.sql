-- Migration 008: Seed DoJ&CD department lookup table
-- These are the official department branches that clients register under.
-- The names here must match the DEPARTMENTS array in ClientRegisterScreen.jsx exactly,
-- since client_user.department_id (VARCHAR) stores the department name string.
-- ON CONFLICT DO NOTHING makes this idempotent (safe to re-run).

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
