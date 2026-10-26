// A pretend Active Directory for trying directory sign-in on your own computer.
//
//   npm run dev:mock-directory
//
// It starts a small LDAP server (the same stand-in the automated tests use) with a few made-up people, and
// prints the lines to put in .env so the backend signs people in against it. It is NOT a domain controller and
// is never to be used outside development: it speaks plain ldap:// and every password is the same.

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to start: the mock directory is for local development only.');
    process.exit(1);
}

const { startMockAd, user, BASE, SERVICE_DN } = require('../../test/helpers/mockAd');

const PORT = parseInt(process.env.MOCK_DIRECTORY_PORT || '1389', 10);
const PASSWORD = 'Correct-Horse-9';
const guid = (n) => `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const people = [
    user({ given: 'Ada', sn: 'Admin',    sam: 'aadmin',    guid: guid(1), employeeId: '10000001', password: PASSWORD }),
    user({ given: 'Mia', sn: 'Manager',  sam: 'mmanager',  guid: guid(2), employeeId: '10000002', password: PASSWORD }),
    user({ given: 'Fay', sn: 'Finance',  sam: 'ffinance',  guid: guid(3), employeeId: '10000003', password: PASSWORD }),
    user({ given: 'Pat', sn: 'Plain',    sam: 'pplain',    guid: guid(4), employeeId: '10000004', password: PASSWORD }),
    user({ given: 'Dan', sn: 'Disabled', sam: 'ddisabled', guid: guid(5), employeeId: '10000005', password: PASSWORD, uac: '514' }),
];
const [admin, manager, finance] = people;

const group = (cn, members) => ({ dn: `CN=${cn},OU=Groups,${BASE}`, cn, members: members.map((m) => m.dn) });
const groups = [group('DOJCD-Admins', [admin]), group('DOJCD-Managers', [manager]), group('DOJCD-Finance', [finance])];

(async () => {
    const ad = await startMockAd({ users: people, groups, servicePassword: 'service-secret', port: PORT });
    console.log(`
Mock directory running at ${ad.url}   (Ctrl+C to stop)

1. Put these in .env (replace the existing AUTH_PROVIDER line), then restart the backend:

AUTH_PROVIDER=ldap
LDAP_URL=${ad.url}
LDAP_ALLOW_INSECURE=true
LDAP_BIND_DN=${SERVICE_DN}
LDAP_BIND_PASSWORD=service-secret
LDAP_BASE_DN=${BASE}
AD_GROUP_ADMIN=DOJCD-Admins
AD_GROUP_MANAGER=DOJCD-Managers
AD_GROUP_FINANCE=DOJCD-Finance
AUTH_ALLOWED_REDIRECTS=http://localhost:3000/auth/callback,http://localhost:3001/auth/callback

2. Sign in (every password is ${PASSWORD}):

   aadmin     Admin group     -> Admin in the admin dashboard
   mmanager   Manager group   -> Manager
   ffinance   Finance group   -> Finance
   pplain     no group        -> a client in the client portal (starts Pending), "no staff access" in the dashboard
   ddisabled  disabled        -> refused by the directory

   Try email, short name (aadmin) or EXAMPLE\\aadmin. A wrong password should say "Invalid username or password".
`);
})().catch((err) => { console.error(err); process.exit(1); });
