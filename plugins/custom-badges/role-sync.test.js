const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBadgeSyncAuthorized,
  linkedBadgeIdsForRoles,
  normalizeRoleSyncSnapshot,
} = require('./role-sync');

test('normalizes role snapshots, deduplicating role IDs', () => {
  assert.deepEqual(normalizeRoleSyncSnapshot({
    guild_id: '1518021155376594944',
    user_id: '123456789012345678',
    role_ids: ['1518032794880573441', '1518032794880573441'],
  }), {
    guildId: '1518021155376594944',
    userId: '123456789012345678',
    roleIds: ['1518032794880573441'],
  });
});

test('accepts an empty role snapshot for members leaving a guild', () => {
  assert.deepEqual(normalizeRoleSyncSnapshot({
    guild_id: '1518021155376594944',
    user_id: '123456789012345678',
    role_ids: [],
  }).roleIds, []);
});

test('rejects malformed or oversized role snapshots', () => {
  assert.equal(normalizeRoleSyncSnapshot({ guild_id: 'x', user_id: '1', role_ids: [] }), null);
  assert.equal(normalizeRoleSyncSnapshot({ guild_id: '1', user_id: '2', role_ids: ['not-a-role'] }), null);
  assert.equal(normalizeRoleSyncSnapshot({ guild_id: '1', user_id: '2', role_ids: Array(501).fill('3') }), null);
});

test('matches multiple linked roles to the same badge only once', () => {
  const links = [
    { badge_id: 'encora_developers', role_id: '1518032740472061952' },
    { badge_id: 'encora_developers', role_id: '1562450044324413440' },
    { badge_id: 'encora_staff', role_id: '1518032794880573441' },
    { badge_id: 'encora_bug_hunter', role_id: '1569672387635445760' },
  ];

  assert.deepEqual(linkedBadgeIdsForRoles(links, ['1562450044324413440']), ['encora_developers']);
  assert.deepEqual(linkedBadgeIdsForRoles(links, ['1518032794880573441', '1518032740472061952']), [
    'encora_developers',
    'encora_staff',
  ]);
  assert.deepEqual(linkedBadgeIdsForRoles(links, ['1569672387635445760']), ['encora_bug_hunter']);
  assert.deepEqual(linkedBadgeIdsForRoles(links, []), []);
});

test('sync authorization accepts only the configured bearer token', () => {
  assert.equal(isBadgeSyncAuthorized('Bearer sync-token', 'sync-token'), true);
  assert.equal(isBadgeSyncAuthorized('Bearer wrong-token', 'sync-token'), false);
  assert.equal(isBadgeSyncAuthorized('Bot sync-token', 'sync-token'), false);
  assert.equal(isBadgeSyncAuthorized('Bearer sync-token', ''), false);
});
