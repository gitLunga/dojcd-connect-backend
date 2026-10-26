const { getDirectoryAuth, publicAuthConfig } = require('../directory');
const { getDirectoryConfig } = require('../directory/config');
const { DirectoryError } = require('../directory/errors');
const authService = require('../services/authService');

const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

function sendError(res, err) {
    if (err instanceof DirectoryError) {
        return res.status(err.status).json({ success: false, code: err.code, message: err.message, data: null, timestamp: new Date().toISOString() });
    }
    console.error('Directory sign-in error:', err);
    return res.status(500).json({ success: false, message: 'Sign-in failed. Please try again.', data: null, timestamp: new Date().toISOString() });
}

const sendSession = (res, session, message = 'Login successful') => res.status(200).json({
    success: true, message,
    data: { user: session.user, accessToken: session.accessToken, refreshToken: session.refreshToken },
    timestamp: new Date().toISOString(),
});

class DirectoryController {

    // GET /api/auth/config  (public): which sign-in screen to draw. No secrets.
    config(req, res) {
        return res.status(200).json({ success: true, data: publicAuthConfig(), timestamp: new Date().toISOString() });
    }

    // Used by the existing /login, /login-client and /login-operational routes when AUTH_PROVIDER is not "local".
    // `audience` is "client" (client portal) or "staff" (admin dashboard).
    async passwordLogin(req, res, audience) {
        try {
            const cfg = getDirectoryConfig();
            if (cfg.provider === 'entra') {
                return res.status(400).json({
                    success: false, code: 'USE_MICROSOFT_SIGN_IN',
                    message: 'Sign in with your Microsoft account.', data: null, timestamp: new Date().toISOString(),
                });
            }

            const username = req.body?.username ?? req.body?.email;
            const ip = clientIp(req);

            if (audience === 'staff' && cfg.allowLocalAdminLogin) {
                const local = await authService.loginLocalBreakGlassAdmin({ email: username, password: req.body?.password }, ip);
                if (local) return sendSession(res, local, 'Operational user login successful');
            }

            const session = await getDirectoryAuth().passwordSignIn({ username, password: req.body?.password, audience, ip });
            return sendSession(res, session, audience === 'staff' ? 'Operational user login successful' : 'Login successful');
        } catch (err) {
            return sendError(res, err);
        }
    }

    // GET /api/auth/entra/login?audience=staff|client&redirect=<front-end url>
    // Sends the browser to Microsoft. With ?format=json it returns the URL instead (for apps that open it themselves).
    async entraLogin(req, res) {
        try {
            const url = await getDirectoryAuth().startEntraLogin({ audience: req.query.audience, redirect: req.query.redirect });
            if (req.query.format === 'json') {
                return res.status(200).json({ success: true, data: { url }, timestamp: new Date().toISOString() });
            }
            return res.redirect(302, url);
        } catch (err) {
            return sendError(res, err);
        }
    }

    // GET /api/auth/entra/callback: Microsoft sends the browser back here with ?code=&state=
    async entraCallback(req, res) {
        try {
            const { redirectTo } = await getDirectoryAuth().finishEntraLogin({
                code: req.query.code, state: req.query.state,
                error: req.query.error, errorDescription: req.query.error_description,
                ip: clientIp(req),
            });
            return res.redirect(302, redirectTo);
        } catch (err) {
            // No usable state means we do not know where to send the person, so answer here.
            if (err instanceof DirectoryError) {
                return res.status(err.status).type('text/plain').send(`${err.message}\n\nClose this tab and start the sign-in again.`);
            }
            console.error('Entra callback error:', err);
            return res.status(500).type('text/plain').send('Sign-in failed. Close this tab and start again.');
        }
    }

    // POST /api/auth/directory/exchange { ticket }: swaps the one-time ticket for tokens.
    async exchange(req, res) {
        try {
            const session = await getDirectoryAuth().exchangeTicket(req.body?.ticket);
            return sendSession(res, session);
        } catch (err) {
            return sendError(res, err);
        }
    }

    // POST /api/admin/directory/sync?dryRun=true|false&force=true|false  (Admin)
    async sync(req, res) {
        try {
            const result = await getDirectoryAuth().syncDirectory({
                dryRun: String(req.query.dryRun ?? req.body?.dryRun) === 'true',
                force: String(req.query.force ?? req.body?.force) === 'true',
            });
            return res.status(200).json({
                success: true,
                message: result.dryRun ? 'Dry run: nothing was changed.' : 'Directory sync complete.',
                data: result, timestamp: new Date().toISOString(),
            });
        } catch (err) {
            return sendError(res, err);
        }
    }
}

module.exports = new DirectoryController();
