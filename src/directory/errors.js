// One error type for everything that can go wrong signing in through the directory.
// `code` is stable (front-ends and tests rely on it); `message` is safe to show to the person;
// `status` is the HTTP status the controller answers with.

const STATUS = {
    INVALID_CREDENTIALS:   401,
    ACCOUNT_DISABLED:      403,
    ACCOUNT_LOCKED:        403,
    PASSWORD_EXPIRED:      403,
    NO_STAFF_ACCESS:       403,
    NOT_ALLOWED:           403,
    ACCOUNT_DEACTIVATED:   403,
    ACCOUNT_CONFLICT:      409,
    USE_DIRECTORY_SIGN_IN: 409,
    REGISTRATION_UNAVAILABLE: 503,
    NO_EMAIL:              422,
    TOO_MANY_ATTEMPTS:     429,
    DIRECTORY_UNAVAILABLE: 503,
    BAD_REQUEST:           400,
    NOT_CONFIGURED:        400,
};

class DirectoryError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'DirectoryError';
        this.code = code;
        this.status = STATUS[code] || 500;
        Object.assign(this, extra);
    }
}

module.exports = { DirectoryError };
