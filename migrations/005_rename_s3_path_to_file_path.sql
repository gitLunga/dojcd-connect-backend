-- Rename s3_path → file_path in document and report tables.
-- The column stored local disk paths all along; the name was inherited from
-- an earlier Supabase/S3 design and is now misleading.

ALTER TABLE document RENAME COLUMN s3_path TO file_path;
ALTER TABLE report   RENAME COLUMN s3_path TO file_path;
