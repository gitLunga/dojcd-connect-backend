-- Migration 009: sign-in through Microsoft Active Directory / Entra ID
--
-- Directory users are matched on a stable directory id (AD objectGUID or Entra object id),
-- never on a password, so:
--   * password_hash becomes optional (directory accounts have no local password)
--   * auth_source records where an account signs in ('local' = email + password in this DB)
--   * external_id is the directory's immutable id for the person
--   * operational_user.role_source says who decided the role:
--       'manual'          an Admin set it in the dashboard (it is kept if the person has no mapped group)
--       'directory_group' it came from AD group membership (it is removed again when the group is)
--
-- Two small tables carry the browser sign-in for Entra ID: the in-flight login (state, PKCE
-- verifier, nonce) and the one-time ticket the front-end swaps for tokens.
--
-- Safe to re-run.

BEGIN;

-- ── client_user ──────────────────────────────────────────────────────────────
ALTER TABLE client_user
    ADD COLUMN IF NOT EXISTS auth_source         VARCHAR(10) NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS external_id         VARCHAR(255),
    ADD COLUMN IF NOT EXISTS directory_upn       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS directory_synced_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE client_user ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE client_user DROP CONSTRAINT IF EXISTS client_user_auth_source_check;
ALTER TABLE client_user
    ADD CONSTRAINT client_user_auth_source_check CHECK (auth_source IN ('local', 'ldap', 'entra'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_user_external
    ON client_user (auth_source, external_id) WHERE external_id IS NOT NULL;

-- ── operational_user ─────────────────────────────────────────────────────────
ALTER TABLE operational_user
    ADD COLUMN IF NOT EXISTS auth_source         VARCHAR(10) NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS external_id         VARCHAR(255),
    ADD COLUMN IF NOT EXISTS directory_upn       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS directory_synced_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS role_source         VARCHAR(20) NOT NULL DEFAULT 'manual';

ALTER TABLE operational_user ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE operational_user DROP CONSTRAINT IF EXISTS operational_user_auth_source_check;
ALTER TABLE operational_user
    ADD CONSTRAINT operational_user_auth_source_check CHECK (auth_source IN ('local', 'ldap', 'entra'));

ALTER TABLE operational_user DROP CONSTRAINT IF EXISTS operational_user_role_source_check;
ALTER TABLE operational_user
    ADD CONSTRAINT operational_user_role_source_check CHECK (role_source IN ('manual', 'directory_group'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_user_external
    ON operational_user (auth_source, external_id) WHERE external_id IS NOT NULL;

-- ── Entra ID browser sign-in ─────────────────────────────────────────────────
-- Both tables hold only SHA-256 hashes of the secrets that travel through the browser.
CREATE TABLE IF NOT EXISTS directory_login_state (
    state_hash    CHAR(64)     PRIMARY KEY,
    code_verifier VARCHAR(128) NOT NULL,
    nonce         VARCHAR(64)  NOT NULL,
    audience      VARCHAR(10)  NOT NULL CHECK (audience IN ('staff', 'client')),
    redirect_uri  TEXT         NOT NULL,
    expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS directory_login_ticket (
    ticket_hash CHAR(64)    PRIMARY KEY,
    user_id     INTEGER     NOT NULL,
    user_type   VARCHAR(12) NOT NULL CHECK (user_type IN ('Client', 'Operational')),
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at     TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

COMMIT;
