# Database — shared template

One script gives every developer the **same** schema, whatever their database looks like today.

```bash
./database/setup.sh --create-db --seed     # new database: schema + departments + sample devices
./database/setup.sh                        # existing database: bring it up to date
./database/setup.sh --verify-only          # compare only, change nothing
DB_NAME=dojcd_test_yourname ./database/setup.sh --create-db --seed   # your own database
```

Connection comes from `.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`); anything you
export in the shell wins over `.env`. Without bash, run the SQL directly:
`psql -d <db> -v ON_ERROR_STOP=1 -f database/schema.sql` then `-f database/verify_schema.sql`.

| File | Purpose |
|---|---|
| `schema.sql` | **The template.** 20 tables. Idempotent: creates what is missing, upgrades what is old, never drops data. |
| `seed.sql` | Reference data: 10 DoJ&CD departments, 8 sample devices. Idempotent. No users or passwords. |
| `verify_schema.sql` | Compares a database with the template. Fails (exit 3) on anything missing, and lists tables that exist in your database but not in the template. |
| `setup.sh` | Runs the three above. |

## The rule

**Change the schema in `schema.sql`, and add any new table name to `verify_schema.sql`. Commit both.**
A table that exists only in your local database does not exist for anyone else.

## Why the databases differed

`dojc_db.sql` creates 15 tables. Everything after that lived in `migrations/` and a side script that
could not be run in order on a fresh database:

- `migrations/005` fails on a fresh `dojc_db.sql` (`s3_path` is already `file_path`).
- `migrations/008` fails: it seeds `department`, a table only `all_migrations.sql` and
  `src/scripts/migrate-department-isolation.sql` create.
- `operational_user.has_global_access`, which login reads, exists only in those same two files.
- `all_migrations.sql` stops at 006 (no 007 `Deactivated` status, no 008 departments).

`schema.sql` replaces all of them. The old files stay in git as history; do not run them.

## Tables created in your local database only

If `verify_schema.sql` prints `INFO tables NOT in the template`, those tables were made by hand or by
a script that was never committed. It prints the exact `pg_dump` command to capture them; add the DDL
to `schema.sql` (and the names to `verify_schema.sql`) so everyone gets them.
