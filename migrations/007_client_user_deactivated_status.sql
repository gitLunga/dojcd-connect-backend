-- Migration 007: Add 'Deactivated' status to client_user registration_status
-- Allows admins to soft-delete (deactivate) client accounts without removing data.
-- Idempotent: safe to run multiple times.

DO $$
BEGIN
    -- Drop the existing CHECK constraint by name (PostgreSQL auto-names it
    -- client_user_registration_status_check from the schema definition).
    -- We catch the error in case it was already renamed or dropped.
    ALTER TABLE client_user
        DROP CONSTRAINT IF EXISTS client_user_registration_status_check;

    -- Add the updated constraint that includes 'Deactivated'.
    ALTER TABLE client_user
        ADD CONSTRAINT client_user_registration_status_check
        CHECK (registration_status IN (
            'Pending', 'Profile_Completed', 'Verified', 'Rejected', 'Deactivated'
        ));
END $$;
