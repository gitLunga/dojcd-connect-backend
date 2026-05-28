-- =============================================================================
-- Migration 003 — Add password_reset_token table
-- =============================================================================
-- Stores hashed one-time tokens for the forgot-password flow.
-- Tokens expire in 60 minutes and can only be used once.
--
-- UP:   psql -U <user> -d <dbname> -f migrations/003_add_password_reset_token.sql
-- =============================================================================

BEGIN;

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

-- Lookup by email to check for recent requests (rate-limit)
CREATE INDEX IF NOT EXISTS idx_prt_email ON password_reset_token (email, created_at DESC);
-- Direct hash lookup on every reset attempt
CREATE INDEX IF NOT EXISTS idx_prt_hash  ON password_reset_token (token_hash);

COMMIT;

-- =============================================================================
-- DOWN
-- =============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS password_reset_token;
-- COMMIT;
