-- Migration 009: Client-initiated device returns
-- Lets a client request the return of their own device (self-service) instead of staff
-- raising it for them. Idempotent: safe to run multiple times.
--
--   * device_return.initiated_by was NOT NULL REFERENCES operational_user, so a client
--     (who is not an operational user) could not be recorded as the initiator.
--     It is now nullable, and initiated_by_type says who raised the request:
--       'Operational' -> initiated_by holds the staff op_user_id   (existing behaviour)
--       'Client'      -> initiated_by is NULL (the owner is already in client_user_id)
--   * approved_at / assessed_at / cancelled_at complete the timeline the client sees
--     (initiated_at, collected_at and completed_at already existed).
--   * visible_to_client: the department's grade and notes on a return are shown to the client
--     only for returns created after this migration. Rows that already exist were written when
--     those fields were internal, so they stay hidden (default false).

ALTER TABLE device_return
    ALTER COLUMN initiated_by DROP NOT NULL;

ALTER TABLE device_return
    ADD COLUMN IF NOT EXISTS initiated_by_type VARCHAR(20) NOT NULL DEFAULT 'Operational',
    ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS assessed_at       TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS visible_to_client  BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_device_return_initiator'
                      AND conrelid = 'device_return'::regclass) THEN
        ALTER TABLE device_return
            ADD CONSTRAINT chk_device_return_initiator CHECK (
                (initiated_by_type = 'Operational' AND initiated_by IS NOT NULL)
             OR (initiated_by_type = 'Client'      AND initiated_by IS NULL)
            );
    END IF;
END $$;
