# Signing in with Microsoft Active Directory / Entra ID

People no longer register. With directory sign-in, an account is created **automatically the first time someone signs in**, from what the directory says about them, and their password is only ever checked by Microsoft or the domain controller. This server stores no password for them.

| | Before (`AUTH_PROVIDER=local`) | After (`ldap` or `entra`) |
|---|---|---|
| Client (advocate, magistrate) | Registers with an email and a new password | Signs in with their organisation account; the account appears on first sign-in (or ahead of time, with the client import in section 6), then completes their profile and is verified by an Admin exactly as before. Clients who are **not** in the directory can still be allowed to register with a password (section 6b) |
| Staff (Admin, Manager, Finance…) | An Admin adds them and emails a temporary password | They are in an AD group; the account appears on first sign-in. Admins can also pre-authorise someone by email |
| Passwords | Kept here (bcrypt), reset by email | Never kept here. Forgot-password, change-password and the temporary-password step are switched off |
| Roles | Chosen by an Admin | From AD groups (below), and/or chosen by an Admin |

Local mode is still the default, so nothing changes until you set `AUTH_PROVIDER`.

## 1. Pick a mode

| | `entra` (Microsoft Entra ID) | `ldap` (on-premises Active Directory) |
|---|---|---|
| Person sees | The Microsoft sign-in page (MFA, conditional access, SSO all apply) | Our own email/password form; the password goes to a domain controller over LDAPS |
| Backend needs | Internet access to `login.microsoftonline.com` and `graph.microsoft.com` | A network route to a domain controller on port 636 |
| Good when | The department uses Microsoft 365 / hybrid identity | The backend is inside the department's network and users have domain accounts only |

Set one in `.env`. The server **refuses to start** if the chosen mode is incomplete, so a typo shows up at boot rather than on someone's first sign-in.

## 2. Prepare the database (once)

```bash
psql -d <your database> -f migrations/009_directory_auth.sql
```

It is safe to re-run. It makes `password_hash` optional, records where each account signs in, and adds the two small tables the Microsoft browser flow uses. Existing accounts are untouched.

## 3a. Microsoft Entra ID

1. **Entra admin centre → App registrations → New registration.** Name it `DOJCD Connect`, choose *Accounts in this organizational directory only*. Under *Redirect URI* pick **Web** and enter the API's callback, for example `https://api.example.gov.za/api/auth/entra/callback`.
2. Copy **Directory (tenant) ID** and **Application (client) ID**. The tenant must be the GUID, not a domain name; the server rejects anything else so a token from another tenant can never be accepted.
3. **Certificates & secrets → New client secret.** Copy the *value* now.
4. **API permissions:** `Microsoft Graph → Delegated → User.Read` (present by default; people consent for themselves). Nothing else is needed to sign in.
5. Create security groups for the roles (for example `DOJCD-Admins`, `DOJCD-Managers`, `DOJCD-Finance`) and add people. Copy each group's **Object ID** if you prefer ids over names.
6. Set in `.env`:

```ini
AUTH_PROVIDER=entra
ENTRA_TENANT_ID=<tenant guid>
ENTRA_CLIENT_ID=<application guid>
ENTRA_CLIENT_SECRET=<secret value>
ENTRA_REDIRECT_URI=https://api.example.gov.za/api/auth/entra/callback
AUTH_ALLOWED_REDIRECTS=https://admin.example.gov.za/auth/callback,https://client.example.gov.za/auth/callback
AD_GROUP_ADMIN=DOJCD-Admins
AD_GROUP_MANAGER=DOJCD-Managers
AD_GROUP_FINANCE=DOJCD-Finance
```

`AUTH_ALLOWED_REDIRECTS` is the list of front-end pages a person may be sent back to. Anything else is refused, so the sign-in cannot be used to bounce someone to another site. The front-ends use `/auth/callback` on their own address. The mobile app uses its own app link, `dojcdconnect://auth/callback`: add it to the list too (scheme, host and path must all match exactly). Expo Go cannot use Microsoft sign-in because its link changes with your IP address; use a development or release build.

*Optional, for the directory sync (section 6):* add **Application** permissions `User.Read.All` and `GroupMember.Read.All` and **grant admin consent**. Sign-in itself never needs them.

## 3b. On-premises Active Directory (LDAPS)

1. Create a **read-only service account** (an ordinary domain user with no special rights). It only searches for people and reads their groups; it never changes anything.
2. Make sure the domain controllers answer **LDAPS on 636** with a certificate the backend trusts. If it comes from your own CA, save the CA certificate (PEM) on the server and point `LDAP_CA_FILE` at it. Never switch certificate checking off.
3. Check the route from the backend host:

```bash
ldapsearch -H ldaps://dc01.example.local:636 -D "CN=svc-dojcd,OU=Service Accounts,DC=example,DC=local" -W \
  -b "DC=example,DC=local" "(sAMAccountName=jsmith)" sAMAccountName mail memberOf
```

4. Set in `.env`:

```ini
AUTH_PROVIDER=ldap
LDAP_URL=ldaps://dc01.example.local:636
LDAP_BIND_DN=CN=svc-dojcd,OU=Service Accounts,DC=example,DC=local
LDAP_BIND_PASSWORD=<service account password>
LDAP_BASE_DN=DC=example,DC=local
LDAP_CA_FILE=/etc/ssl/dojcd/ca.pem
AD_GROUP_ADMIN=DOJCD-Admins
AD_GROUP_MANAGER=DOJCD-Managers
AD_GROUP_FINANCE=DOJCD-Finance
```

People can type their email, their UPN (`jsmith@example.local`), their short name (`jsmith`) or `EXAMPLE\jsmith`. Nested groups are followed. Plain `ldap://` is refused at start-up unless you opt in with `LDAP_STARTTLS=true` (or `LDAP_ALLOW_INSECURE=true` for a lab), because the password would otherwise cross the network in clear text.

The sign-in form posts to the same endpoints as before, so the front-ends work with this mode as they are; the updated ones also hide the register and forgot-password links.

## 4. Roles

A person's role comes from the groups you name in `.env`. Each setting takes group **names** separated by commas, or full **DNs** separated by semicolons (a DN contains commas).

| Setting | Gives |
|---|---|
| `AD_GROUP_ADMIN` | Admin (strongest) |
| `AD_GROUP_FINANCE` | Finance |
| `AD_GROUP_MANAGER` | Manager |
| `AD_GROUP_APPROVER` | Approver |
| `AD_GROUP_MTN_STAFF` | MTN_Staff |
| `AD_GROUP_SUPER_ADMIN` | the Super Admin flag (optional; see below) |
| `AD_GROUP_MAGISTRATES` | client type *Magistrate* (everyone else is `DIRECTORY_DEFAULT_USER_TYPE`, default *Advocate*) |
| `AD_GROUP_CLIENTS` | optional: only these people may use the client portal. Empty = every directory user |

Rules:

* **The strongest group wins.** In `DOJCD-Managers` and `DOJCD-Finance` means Finance.
* **Groups beat hand-assigned roles.** If someone is in a mapped group, the group decides on every sign-in.
* **No mapped group:** a role an Admin set by hand is kept. A role that came from a group is **withdrawn** when the person leaves it: the account is switched off (not deleted, so history stays attached) and they can no longer sign in as staff. Putting them back in the group switches it on again.
* **Super Admin:** *Add User* and *Sync from directory* in the dashboard are for Super Admins. A person who is only in `AD_GROUP_ADMIN` is an Admin, not a Super Admin. Either set `AD_GROUP_SUPER_ADMIN` (the flag then follows that group for group-managed accounts), or create the first one with `create-admin` (section 5, which makes a Super Admin) and promote others in the dashboard as before.
* Changes in AD take effect the next time the person signs in (or the next sync).
* Someone who is both staff and a client can use both portals: staff and client accounts are separate, chosen by which portal they sign in to.

Everyone else in the directory can use the **client portal**: the first sign-in creates an *unverified* client. Name, email and phone come from the directory; user type, department, region and PERSAL number are filled in once (the PERSAL number from `employeeID`, or `LDAP_ATTR_PERSAL`) and are never overwritten afterwards, so an Admin's corrections stay.

## 5. The first Admin, and existing accounts

* **Put the person in the Admin group** and have them sign in to the admin dashboard, **or** pre-authorise them by email without a password:
  `AUTH_PROVIDER=entra npm run create-admin -- --email jane@dojcd.gov.za --first-name Jane --last-name Doe`
* Admins can pre-authorise other staff in **Operational Users → Add User**. No password is created or emailed; the person signs in with their organisation account and is matched by email.
* **Existing local accounts are linked, not duplicated.** On first directory sign-in the account with the same email is adopted (clients keep their verification, documents and applications; staff keep their history). Its local password stops working. If two different directory identities ever claim one email, the second is refused.

### Break-glass

If the directory is down nobody can sign in. To keep one way in, create a local Admin with `AUTH_PROVIDER=local npm run create-admin -- ...` (before switching mode) and set `AUTH_ALLOW_LOCAL_ADMIN_LOGIN=true`. That account can then sign in with its own password at the admin dashboard. Leave it off if you would rather have no local passwords at all.

### Going back

Not automatic. To return to local passwords, set `AUTH_PROVIDER=local`, release the accounts, and have people use **Forgot password** to set one:

```sql
UPDATE client_user      SET auth_source = 'local', external_id = NULL WHERE auth_source <> 'local';
UPDATE operational_user SET auth_source = 'local', external_id = NULL WHERE auth_source <> 'local';
```

## 6. Pulling users in: the sync

Sign-in creates accounts on demand. The sync does it ahead of time, so people already exist (and an Admin can see them) before their first sign-in, and keeps staff tidy. **There is no registration and no one-by-one creation: a department of 500 people is one click.**

```bash
npm run sync-directory -- --dry-run             # staff: shows what would change, changes nothing
npm run sync-directory                          # staff: creates/updates, switches off group-granted staff who left
npm run sync-directory -- --clients --dry-run   # clients: what an import would do
npm run sync-directory -- --clients             # clients: import everyone else in the directory
npm run sync-directory -- --all                 # staff and clients
```

In the admin dashboard the same thing is the **Sync from directory** button (Operational Users for staff, Client Users for clients). It always shows a preview first. In the API:

`POST /api/admin/directory/sync?scope=staff|clients|all&dryRun=true|false&force=true|false` (Admin). Without `scope` it behaves as it always did: staff, plus the clients group's members when `AD_GROUP_CLIENTS` is set.

**Staff.** Creates or updates the people in the role groups and switches off group-granted staff whose person has left every group. If the directory returns **nobody** for the staff groups (wrong group name, connection problem), the sync refuses to switch everyone off unless you add `--force`.

**Clients.**
* With `AD_GROUP_CLIENTS` set, the members of that group are imported. Otherwise **every enabled person in the directory who has an email address or UPN** is, except anyone who holds a staff role (they have a staff account; they can still use the client portal, which creates the client account on first sign-in).
* They arrive exactly as if they had signed in once: an **unverified** client (name, email, phone and PERSAL number from the directory; user type *Magistrate* for members of `AD_GROUP_MAGISTRATES`, otherwise `DIRECTORY_DEFAULT_USER_TYPE`). They still complete their profile and an Admin verifies them, because that is where the contract details and documents are collected. **No welcome email is sent for an import.**
* A client who had already registered with a password and has the same email is **linked**, keeping their verification, documents and applications. A deactivated client is left alone. An email that already belongs to a different directory account is reported in the result, never taken over.
* Running it again only updates; nobody is duplicated. Someone who signs in later is the same account the import made.
* Not imported: disabled accounts, accounts with no email address and no UPN, and (Entra) guest accounts.
* To leave service accounts, shared mailboxes and the like out, narrow it: `LDAP_SYNC_BASE_DN` (an OU, for example `OU=Staff,DC=dojcd,DC=local`) and `LDAP_SYNC_FILTER` (an extra filter in brackets, for example `(department=*)`). Or put the real people in a group and set `AD_GROUP_CLIENTS`.
* The result lists what was created, linked, updated and skipped, and any errors, for both the preview and the real run. Importing is not undone by a sync: use *deactivate* in the dashboard for a client who has left.

Entra needs the optional application permissions from 3a (`User.Read.All`, `GroupMember.Read.All`) for any sync. Schedule it with cron if you want changes picked up without waiting for sign-ins, for example nightly: `30 2 * * * cd /path/to/backend && npm run sync-directory -- --all >> sync.log 2>&1`. A very large import (thousands) takes a while: run it from the command line rather than the dashboard if your reverse proxy times out after a minute.

### 6b. Clients who are not in the directory (optional registration)

Some clients, an external advocate for instance, may have no organisation account. To let them still register with their own password next to the organisation sign-in, set:

```ini
AUTH_ALLOW_CLIENT_REGISTRATION=true
```

* The client portal and the mobile app then show **Create account** next to the organisation sign-in. In `ldap` mode the one form takes either kind of account (a registered client's password is checked first, anything else goes to the domain controller). In `entra` mode there is the Microsoft button **and** an email/password form for registered clients.
* Those clients are ordinary local accounts: forgot-password and change-password work for them, and only for them. **Staff never self-register and never reset a password here.**
* **An address that exists in the directory cannot be registered with a password**: the person is told to use the organisation sign-in. This stops someone registering a password account for a colleague's address before that colleague first signs in. The check asks the directory at registration time, so if it cannot be reached, registration waits (it never guesses). With Entra this needs the `User.Read.All` application permission.
* If a registered client later gets an organisation account, their first organisation sign-in takes over the same account (verification, documents and applications stay) and the old password stops working.
* Failed sign-ins for these accounts count towards the same pause as organisation sign-ins (section 7).
* Keep the scheduled client import running: once everyone in the directory exists here, their addresses are taken and cannot be registered by anyone else.

Leave it off (the default) if everyone who needs the client portal is in the directory.

## 7. What is recorded

Every account created, linked or switched off by the directory is in the Audit Log (`DIRECTORY_STAFF_PROVISIONED`, `DIRECTORY_CLIENT_PROVISIONED`, `DIRECTORY_ACCOUNT_LINKED`, `DIRECTORY_ROLE_CHANGED`, `DIRECTORY_STAFF_ACCESS_REVOKED`), with actor type *System*. Every sign-in attempt, successful or not, is in Login Attempts. After `AUTH_MAX_FAILED_LOGINS` (default 8) failures for one username from one address, further attempts are paused for `AUTH_FAILED_LOGIN_WINDOW_MINUTES` (default 10), so this server cannot be used to lock someone out of the domain. The domain's own lockout policy still applies.

## 8. Security notes

* The password is only ever sent to the domain controller (`ldap`) or never reaches this server at all (`entra`).
* LDAP: usernames are escaped before they reach a search filter; an empty password is refused before any bind (many servers treat it as an anonymous, successful bind); the person's own bind decides, with the domain's lockout, expiry and disabled-account rules.
* Entra: authorization-code flow with PKCE, a single-use `state`, a `nonce`, and ID-token verification (signature against Microsoft's keys, issuer, audience, expiry). The tokens never appear in a URL: the browser carries a one-time ticket that expires in two minutes.
* Group membership is read from Microsoft Graph, not trusted from the ID token (which omits groups for people in too many).
* **Leavers.** Disabling someone in the directory stops them signing in. A session they already have open lasts at most 15 minutes per access token, and can be renewed for up to 7 days while the front-end keeps refreshing, because a renewal checks *this* system's account, not the directory. Renewal stops once the account is switched off here, which the next sync or their next sign-in attempt does for group-granted staff. For anyone else, deactivate them in the dashboard, and run the sync on a schedule.

## 9. Checking it works

1. `GET /api/auth/config` returns the provider you set.
2. Sign in to the **client portal** with an ordinary account: a client appears under *Client Users* as *Pending*.
3. Sign in to the **admin dashboard** with someone in the Admin group: Operational Users lists them as Admin.
4. Remove them from the group, run `npm run sync-directory`, confirm they are switched off.
5. Try a wrong password five times (ldap): you see *Invalid username or password*, then a pause.
6. Run the client import as a preview (`npm run sync-directory -- --clients --dry-run`), read the counts, then run it for real. Open *Client Users*: the people appear as *Pending*, and none of them received an email.
7. If you turned on `AUTH_ALLOW_CLIENT_REGISTRATION`: register with an address that is **not** in the directory (it works), then with one that is (you are told to use the organisation sign-in).

| Message code | Meaning |
|---|---|
| `INVALID_CREDENTIALS` | Wrong username or password (ldap), or the Microsoft sign-in expired/was already used |
| `ACCOUNT_LOCKED` / `PASSWORD_EXPIRED` / `ACCOUNT_DISABLED` | The domain controller said so. They are only shown after a correct password |
| `NO_STAFF_ACCESS` | Signed in fine, but is in none of the staff groups |
| `NOT_ALLOWED` | `AD_GROUP_CLIENTS` is set and the person is not in it |
| `ACCOUNT_CONFLICT` | Another directory identity already owns this email: an Admin must resolve it |
| `NO_EMAIL` | The directory account has neither `mail` nor a UPN |
| `DIRECTORY_UNAVAILABLE` | The domain controller or Microsoft could not be reached, or the service account / client secret is wrong. See the server log |
| `TOO_MANY_ATTEMPTS` | Paused after repeated failures |
| `USE_DIRECTORY_SIGN_IN` | Someone tried to register with an address that belongs to an organisation account |
| `REGISTRATION_UNAVAILABLE` | Registration needs to ask the directory whether the address is taken, and it could not be reached (Entra: is `User.Read.All` granted?) |

## 10. What has and has not been tested

The automated tests (`npm test`; set `TEST_PG_HOST` to include the database ones) run the real application and a real PostgreSQL against **stand-ins** for the directory: a small in-process LDAP server that speaks the protocol, and a mock Entra ID that signs real tokens and enforces PKCE and the client secret. They cover sign-in, provisioning, roles, linking, switching off, the sync, replay and tampering. They are not a real domain controller or tenant, so on first connection check section 9 against yours, and in particular: your `LDAP_USER_FILTER` (if you changed it), the attribute that holds the PERSAL number, certificate trust for LDAPS, and conditional-access policies on the Entra app.
