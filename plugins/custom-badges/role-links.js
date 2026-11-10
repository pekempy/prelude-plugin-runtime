const { isSnowflake, linkedBadgeIdsForRoles } = require('./role-sync');

class RoleLinkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function apiUrl(baseUrl, pathname) {
  return new URL(pathname.replace(/^\//, ''), `${String(baseUrl).replace(/\/+$/, '')}/`);
}

async function requestBotApi(baseUrl, botToken, pathname) {
  if (!botToken) {
    throw new RoleLinkError(503, 'Bot role lookup is not configured');
  }

  let response;
  try {
    response = await fetch(apiUrl(baseUrl, pathname), {
      headers: { Authorization: `Bot ${botToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new RoleLinkError(502, 'Could not reach the Fluxer API');
  }

  if (!response.ok) {
    throw new RoleLinkError(502, `Fluxer API returned ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new RoleLinkError(502, 'Fluxer API returned invalid JSON');
  }
}

async function fetchBotGuilds(baseUrl, botToken) {
  const guilds = await requestBotApi(baseUrl, botToken, 'v1/users/@me/guilds');
  if (!Array.isArray(guilds)) {
    throw new RoleLinkError(502, 'Fluxer API returned an invalid guild list');
  }

  return guilds
    .filter(guild => isSnowflake(String(guild.id)) && typeof guild.name === 'string')
    .map(guild => ({ id: String(guild.id), name: guild.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchBotGuildRoles(baseUrl, botToken, guildId) {
  if (!isSnowflake(guildId)) {
    throw new RoleLinkError(400, 'Invalid guild ID');
  }

  const roles = await requestBotApi(baseUrl, botToken, `v1/guilds/${encodeURIComponent(guildId)}/roles`);
  if (!Array.isArray(roles)) {
    throw new RoleLinkError(502, 'Fluxer API returned an invalid role list');
  }

  return roles
    .filter(role => String(role.id) !== String(guildId) && isSnowflake(String(role.id)) && typeof role.name === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureRoleLinkSchema(pool) {
  await pool.query(`
    ALTER TABLE plugin_user_badges
    ADD COLUMN IF NOT EXISTS role_managed BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_badge_role_links (
      id BIGSERIAL PRIMARY KEY,
      badge_id VARCHAR NOT NULL REFERENCES plugin_custom_badges(id) ON DELETE CASCADE,
      guild_id VARCHAR NOT NULL,
      guild_name TEXT NOT NULL,
      role_id VARCHAR NOT NULL,
      role_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (badge_id, guild_id, role_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_user_badge_role_assignments (
      user_id VARCHAR NOT NULL,
      role_link_id BIGINT NOT NULL REFERENCES plugin_badge_role_links(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, role_link_id)
    );
  `);
}

async function getBadgeRoleLinks(pool, badgeId) {
  const result = await pool.query(`
    SELECT id, badge_id, guild_id, guild_name, role_id, role_name
    FROM plugin_badge_role_links
    WHERE badge_id = $1
    ORDER BY guild_name, role_name, id;
  `, [badgeId]);

  return result.rows;
}

async function addBadgeRoleLink(pool, { badgeId, guildId, roleId }, { apiUrl: baseUrl, botToken }) {
  if (!isSnowflake(guildId) || !isSnowflake(roleId)) {
    throw new RoleLinkError(400, 'Select a server and role');
  }

  const badgeResult = await pool.query('SELECT id FROM plugin_custom_badges WHERE id = $1', [badgeId]);
  if (!badgeResult.rows.length) {
    throw new RoleLinkError(404, 'Badge not found');
  }

  const guilds = await fetchBotGuilds(baseUrl, botToken);
  const guild = guilds.find(item => item.id === guildId);
  if (!guild) {
    throw new RoleLinkError(404, 'Server is not available to the Bot');
  }

  const roles = await fetchBotGuildRoles(baseUrl, botToken, guildId);
  const role = roles.find(item => item.id === roleId);
  if (!role) {
    throw new RoleLinkError(404, 'Role was not found in that server');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [badgeId]);

    const existing = await client.query(`
      SELECT DISTINCT guild_id
      FROM plugin_badge_role_links
      WHERE badge_id = $1;
    `, [badgeId]);
    if (existing.rows.some(row => row.guild_id !== guildId)) {
      throw new RoleLinkError(409, 'All linked roles for a badge must come from the same server');
    }

    const result = await client.query(`
      INSERT INTO plugin_badge_role_links (badge_id, guild_id, guild_name, role_id, role_name)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (badge_id, guild_id, role_id) DO UPDATE SET
        guild_name = EXCLUDED.guild_name,
        role_name = EXCLUDED.role_name
      RETURNING id, badge_id, guild_id, guild_name, role_id, role_name;
    `, [badgeId, guildId, guild.name, roleId, role.name]);

    if (!existing.rows.length) {
      await client.query(`
        UPDATE plugin_user_badges
        SET role_managed = TRUE
        WHERE badge_id = $1;
      `, [badgeId]);
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function removeBadgeRoleLink(pool, badgeId, linkId) {
  if (!/^\d{1,20}$/.test(String(linkId))) {
    throw new RoleLinkError(400, 'Invalid linked role ID');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [badgeId]);
    const removed = await client.query(`
      DELETE FROM plugin_badge_role_links
      WHERE id = $1 AND badge_id = $2
      RETURNING badge_id;
    `, [linkId, badgeId]);

    if (!removed.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(`
      DELETE FROM plugin_user_badges AS badge
      WHERE badge.badge_id = $1
        AND badge.role_managed = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM plugin_user_badge_role_assignments AS assignment
          JOIN plugin_badge_role_links AS link ON link.id = assignment.role_link_id
          WHERE assignment.user_id = badge.user_id
            AND link.badge_id = badge.badge_id
        );
    `, [badgeId]);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncMemberRoleSnapshot(pool, { guildId, userId, roleIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
    const roleLinks = await client.query(`
      SELECT id, badge_id, role_id
      FROM plugin_badge_role_links
      WHERE guild_id = $1;
    `, [guildId]);
    const linkedRoleRows = roleLinks.rows;
    if (!linkedRoleRows.length) {
      await client.query('COMMIT');
      return [];
    }

    const guildBadgeIds = [...new Set(linkedRoleRows.map(link => String(link.badge_id)))];
    const activeBadgeIds = linkedBadgeIdsForRoles(linkedRoleRows, roleIds);


    await client.query(`
      DELETE FROM plugin_user_badge_role_assignments AS assignment
      USING plugin_badge_role_links AS link
      WHERE assignment.role_link_id = link.id
        AND assignment.user_id = $1
        AND link.guild_id = $2
        AND NOT (link.role_id = ANY($3::VARCHAR[]));
    `, [userId, guildId, roleIds]);

    await client.query(`
      INSERT INTO plugin_user_badge_role_assignments (user_id, role_link_id)
      SELECT $1, id
      FROM plugin_badge_role_links
      WHERE guild_id = $2 AND role_id = ANY($3::VARCHAR[])
      ON CONFLICT (user_id, role_link_id) DO NOTHING;
    `, [userId, guildId, roleIds]);

    for (const badgeId of activeBadgeIds) {
      await client.query(`
        INSERT INTO plugin_user_badges (user_id, badge_id, role_managed)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (user_id, badge_id) DO NOTHING;
      `, [userId, badgeId]);
    }

    await client.query(`
      DELETE FROM plugin_user_badges AS badge
      WHERE badge.user_id = $1
        AND badge.badge_id = ANY($2::VARCHAR[])
        AND badge.role_managed = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM plugin_user_badge_role_assignments AS assignment
          JOIN plugin_badge_role_links AS link ON link.id = assignment.role_link_id
          WHERE assignment.user_id = badge.user_id
            AND link.badge_id = badge.badge_id
        );
    `, [userId, guildBadgeIds]);

    const result = await client.query(`
      SELECT DISTINCT link.badge_id
      FROM plugin_user_badge_role_assignments AS assignment
      JOIN plugin_badge_role_links AS link ON link.id = assignment.role_link_id
      WHERE assignment.user_id = $1 AND link.guild_id = $2;
    `, [userId, guildId]);

    await client.query('COMMIT');
    return result.rows.map(row => row.badge_id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RoleLinkError,
  addBadgeRoleLink,
  ensureRoleLinkSchema,
  fetchBotGuildRoles,
  fetchBotGuilds,
  getBadgeRoleLinks,
  removeBadgeRoleLink,
  syncMemberRoleSnapshot,
};
