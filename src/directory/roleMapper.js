// Turns directory group membership into application roles. Pure functions, no I/O.
//
// A "profile" lists the groups a person belongs to as plain strings. Each provider adds every
// spelling it knows (AD: full DN, CN and sAMAccountName; Entra: object id and display name), and a
// configured group matches if it equals ANY of them, case-insensitively.

const { STAFF_ROLE_PRIORITY } = require('./config');

// "CN=DOJCD Admins, OU=Groups ,DC=x" and "cn=dojcd admins,ou=groups,dc=x" are the same DN.
function normaliseGroup(value) {
    const s = String(value || '').trim().toLowerCase();
    return s.includes('=') ? s.split(',').map((part) => part.trim().replace(/\s*=\s*/, '=')).join(',') : s;
}

function toGroupSet(groups = []) {
    return new Set(groups.map(normaliseGroup).filter(Boolean));
}

function inAny(configured, groupSet) {
    return configured.some((name) => groupSet.has(normaliseGroup(name)));
}

// The strongest staff role the person's groups grant, or null when none of them is mapped.
function resolveStaffRole(groups, cfg) {
    const set = toGroupSet(groups);
    return STAFF_ROLE_PRIORITY.find((role) => inAny(cfg.groups[role] || [], set)) || null;
}

function isInSuperAdminGroup(groups, cfg) {
    return inAny(cfg.groups.superAdmin, toGroupSet(groups));
}

// An empty clients group means "any directory user may sign in to the client portal".
function isClientAllowed(groups, cfg) {
    if (cfg.groups.clients.length === 0) return true;
    return inAny(cfg.groups.clients, toGroupSet(groups));
}

function resolveUserType(groups, cfg) {
    return inAny(cfg.groups.magistrates, toGroupSet(groups)) ? 'Magistrate' : cfg.defaultUserType;
}

// Which role group(s) a role is granted by, for messages shown to people who lack access.
const groupsForRole = (role, cfg) => cfg.groups[role] || [];

module.exports = {
    normaliseGroup, toGroupSet, resolveStaffRole, isInSuperAdminGroup, isClientAllowed, resolveUserType, groupsForRole,
};
