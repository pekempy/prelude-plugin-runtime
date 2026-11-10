const crypto = require('crypto');

const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

function normalizeRoleSyncSnapshot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const { guild_id: guildId, user_id: userId, role_ids: roleIds } = body;
  if (!isSnowflake(guildId) || !isSnowflake(userId) || !Array.isArray(roleIds) || roleIds.length > 500) {
    return null;
  }

  if (!roleIds.every(isSnowflake)) {
    return null;
  }

  return {
    guildId,
    userId,
    roleIds: [...new Set(roleIds)],
  };
}

function linkedBadgeIdsForRoles(roleLinks, roleIds) {
  const currentRoles = new Set(roleIds);

  return [...new Set(roleLinks
    .filter(link => currentRoles.has(String(link.role_id)))
    .map(link => String(link.badge_id)))];
}

function isBadgeSyncAuthorized(authorization, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0 || typeof authorization !== 'string') {
    return false;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const supplied = Buffer.from(match[1].trim());
  const expected = Buffer.from(expectedToken);

  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {
  isSnowflake,
  isBadgeSyncAuthorized,
  linkedBadgeIdsForRoles,
  normalizeRoleSyncSnapshot,
};
