# Trying the changes on your own computer

Everything below runs locally. Nothing touches the live system. You need Node 18 or newer, PostgreSQL and git.

The work is on the branch `claude/inspiring-babbage-gcrixf` in all four repositories (or on `main` / `master` once merged):

| Repository | Folder | Runs on |
|---|---|---|
| dojcd-connect-backend | backend | http://localhost:5000 |
| admin-dashboard | admin dashboard | http://localhost:3000 |
| DOJCD-Client-Web | client portal | http://localhost:3001 |
| dojcd-connect-frontend | mobile app | Expo |

```bash
git fetch && git checkout claude/inspiring-babbage-gcrixf     # in each repository
```

## 1. A local database

**Best: a copy of the real data.** Restore a backup of the live database into a new local one, then add the two new migrations. This also proves the migrations work on your real data.

```bash
createdb dojcd_local
psql -d dojcd_local -f <your backup>.sql
psql -d dojcd_local -f migrations/009_directory_auth.sql
psql -d dojcd_local -f migrations/010_catalogue_categories.sql
```

**Or an empty one** (the schema and all migrations in order; some early files may print harmless warnings on a fresh database):

```bash
createdb dojcd_local
for f in dojc_db.sql migrations/001_fix_schema.sql migrations/002_add_department_to_operational_user.sql \
  migrations/003_add_password_reset_token.sql migrations/004_inventory_and_resubmit.sql \
  migrations/005_rename_s3_path_to_file_path.sql migrations/006_returns_delegation_budget.sql \
  migrations/007_client_user_deactivated_status.sql src/scripts/migrate-department-isolation.sql \
  migrations/008_seed_doj_departments.sql migrations/009_directory_auth.sql migrations/010_catalogue_categories.sql; do
  psql -d dojcd_local -q -f "$f"
done
```

An empty database has no users. Create the first Admin with `AUTH_PROVIDER=local npm run create-admin -- --email you@example.com --first-name You --last-name Admin` (it prints a one-time password once; you must change it at first sign-in).

## 2. The backend

```bash
npm install
cp .env.example .env      # then set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME (dojcd_local), PORT=5000 and a JWT_SECRET of at least 32 characters
npm run dev
```

Check http://localhost:5000/api/auth/config: it should say `"provider":"local"`.

**Automated tests** (147 of them; the database ones create and drop throwaway databases, so the user needs CREATEDB):

```bash
TEST_PG_HOST=localhost TEST_PG_USER=postgres TEST_PG_PASSWORD=<password> npm test
```

## 3. The front-ends

```bash
cd admin-dashboard   && npm install && npm start                 # http://localhost:3000
cd DOJCD-Client-Web  && npm install && PORT=3001 npm start       # http://localhost:3001
```

Both talk to http://localhost:5000/api. The backend already allows these two addresses.

Mobile: `cd dojcd-connect-frontend && npm install && npx expo start`. In the browser (`w`) it uses localhost. On a phone, change the address in `src/services/api.ts` to your computer's address on the Wi-Fi (for example `http://192.168.1.20:5000/api`). Microsoft (Entra) sign-in in the app needs a development build, not Expo Go; the password form works in Expo Go.

## 4. What to try

**A. Nothing should have changed yet (`AUTH_PROVIDER=local`)**
- Register a client, sign in, forgot password: all still work.
- Admin dashboard: sign in as an Admin. Staff cannot register themselves any more.

**B. Catalogue categories (works in either mode)**
- Admin dashboard, Device Management: category chips with counts. *Manage categories*: add one, hide one, try deleting one that has items (refused) and an empty one (allowed).
- *Add item* in "Data & Connectivity": model and manufacturer are optional. In "Mobile Phones" they are required.
- Client portal, catalogue: the chips filter; a hidden category and its items disappear.

**C. Directory sign-in with a pretend Active Directory**

```bash
npm run dev:mock-directory
```

It prints the lines to put in `.env` (an `ldap` setup that points at the pretend directory) and a list of sample people, all with the password `Correct-Horse-9`. Paste the lines into `.env`, restart the backend, then:

- `/api/auth/config` now says `"provider":"ldap"`; both front-ends hide *Register* and *Forgot password*.
- Admin dashboard: `aadmin` (Admin), `mmanager` (Manager) and `ffinance` (Finance) sign in; `pplain` is told they have no staff access; `ddisabled` is refused; a wrong password is refused. Try `aadmin`, `aadmin@dojcd.gov.za` and `EXAMPLE\aadmin`.
- Client portal: sign in as `pplain`. A client appears (Pending) with no registration. Complete the profile, then verify them as an Admin.
- Admin dashboard, Operational Users: the staff who signed in are listed; run `npm run sync-directory -- --dry-run`.

The pretend directory is not a real domain controller. It only shows that the application behaves; connecting the real one is `docs/directory-sign-in.md`.

**D. Back to normal**
Set `AUTH_PROVIDER=local` again and restart. People who were created from the directory have no password here; see "Going back" in `docs/directory-sign-in.md` (they use *Forgot password*).

## Starting again

```bash
dropdb dojcd_local && createdb dojcd_local     # then repeat step 1
```
