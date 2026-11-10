const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { createPool } = require('../../shared/pg');
const { checkAdminAuth, ALLOWED_ADMIN_TOKENS, checkBearerToken } = require('../../shared/auth');
const { readJsonBody, json } = require('../../shared/http');

const PORT = parseInt(process.env.PORT || '8083', 10);
const BOT_TOKEN = process.env.BOT_TOKEN || 'REDACTED_BOT_TOKEN';
const ENCORA_GUILD_ID = process.env.ENCORA_GUILD_ID || '1518021155376594944';
const ENCORA_LINKED_ROLE_ID = process.env.ENCORA_LINKED_ROLE_ID || '1518032794880573443';

const pool = createPool();

let badgesCache = new Map();
let lastFetchTime = 0;
const CACHE_TTL_MS = 5000; // 5s cache

async function refreshBadgesCache(force = false) {
  const now = Date.now();
  if (!force && now - lastFetchTime < CACHE_TTL_MS && badgesCache.size > 0) {
    return badgesCache;
  }
  try {
    const res = await pool.query(`
      SELECT 
        ub.user_id,
        u.row_data->>'username' AS username,
        b.id AS badge_id,
        b.name AS badge_name,
        b.icon_url,
        COALESCE(b.tooltip, b.name) AS tooltip,
        COALESCE(ub.custom_link, b.default_link) AS link_url
      FROM plugin_user_badges ub
      JOIN plugin_custom_badges b ON ub.badge_id = b.id
      LEFT JOIN fluxer_kv u ON u.table_name = 'users' AND (u.partition_key::jsonb->>'value') = ub.user_id
      ORDER BY ub.user_id, ub.created_at ASC;
    `);
    const nextMap = new Map();
    for (const row of res.rows) {
      const uid = String(row.user_id);
      if (!nextMap.has(uid)) {
        nextMap.set(uid, []);
      }
      nextMap.get(uid).push({
        id: row.badge_id,
        name: row.badge_name,
        icon: row.icon_url,
        tooltip: row.tooltip,
        link: row.link_url,
        username: row.username
      });
    }
    badgesCache = nextMap;
    lastFetchTime = now;
  } catch (err) {
    console.error('[plugin-encora-linking] Database query error:', err.message);
  }
  return badgesCache;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Link Encora endpoint
  if (pathname === '/api/admin/users/link-encora' ||
      pathname === '/custom-badges/api/link-encora' ||
      pathname === '/admin/users/link-encora') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    if (req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^(Admin|Bearer)\s+/i, '').trim();
      const validToken = Boolean(token && ALLOWED_ADMIN_TOKENS.has(token));
      if (!validToken && !checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const { user_id, encora_username, encora_slug } = body;
        if (!user_id || (!encora_username && !encora_slug)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing user_id, encora_username or encora_slug' }));
          return;
        }

        const userIdStr = String(user_id).trim();
        const slug = String(encora_slug || encora_username).toLowerCase().trim();
        const traderUrl = `https://encora.it/traders/${slug}`;
        const domain = `encora.it/traders/${slug}`;
        const connectionId = crypto.createHash('sha256').update(`${userIdStr}:${domain}`).digest('hex');
        const partitionKey = JSON.stringify({ __fluxer_type: 'bigint', value: userIdStr });
        const rowKey = `${partitionKey}\x1f"domain"\x1f"${connectionId}"`;
        const nowIso = new Date().toISOString();

        // 1. Add/update badge in plugin_user_badges
        await pool.query(`
          INSERT INTO plugin_user_badges (user_id, badge_id, custom_link)
          VALUES ($1, 'encora_linked', $2)
          ON CONFLICT (user_id, badge_id) DO UPDATE SET
            custom_link = EXCLUDED.custom_link;
        `, [userIdStr, traderUrl]);

        await refreshBadgesCache(true);

        // 2. Add/update connection in fluxer_kv (user_connections)
        const countRes = await pool.query(`
          SELECT count(*)::int AS cnt FROM fluxer_kv
          WHERE table_name = 'user_connections' AND partition_key = $1;
        `, [partitionKey]);
        const sortOrder = countRes.rows[0]?.cnt || 0;

        const connData = {
          user_id: { __fluxer_type: 'bigint', value: userIdStr },
          connection_id: connectionId,
          connection_type: 'domain',
          identifier: domain,
          name: domain,
          verified: true,
          visibility_flags: 1,
          sort_order: sortOrder,
          verification_token: '',
          verified_at: { __fluxer_type: 'date', value: nowIso },
          last_verified_at: { __fluxer_type: 'date', value: nowIso },
          created_at: { __fluxer_type: 'date', value: nowIso },
          version: 1
        };

        await pool.query(`
          INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, updated_at)
          VALUES ('user_connections', $1, $2, $3::jsonb, NOW())
          ON CONFLICT (table_name, row_key) DO UPDATE SET
            row_data = fluxer_kv.row_data || jsonb_build_object(
              'name', $4::text,
              'verified', true,
              'last_verified_at', jsonb_build_object('__fluxer_type', 'date', 'value', $5::text)
            ),
            updated_at = NOW();
        `, [partitionKey, rowKey, JSON.stringify(connData), domain, nowIso]);

        // 3. Update custom_badge_url on user in fluxer_kv (users)
        await pool.query(`
          UPDATE fluxer_kv
          SET row_data = row_data || jsonb_build_object(
                'custom_badge_url', 'https://encora.it/images/favicon.png',
                'custom_badge_link', $2::text
              ),
              updated_at = NOW()
          WHERE table_name = 'users' AND row_key = $1;
        `, [partitionKey, traderUrl]);

        // 4. Ensure guild role is applied in Encora Reprise server
        try {
          await new Promise((resolve) => {
            const r = https.request(`https://prelude.chat/api/guilds/${ENCORA_GUILD_ID}/members/${userIdStr}/roles/${ENCORA_LINKED_ROLE_ID}`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bot ${BOT_TOKEN}`,
                'User-Agent': 'Encora/1.0'
              }
            }, (res) => {
              res.resume();
              resolve();
            });
            r.on('error', () => resolve());
            r.end();
          });
        } catch (e) {}

        console.log(`[plugin-encora-linking] Linked Encora account: user ${userIdStr} -> ${domain}`);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          success: true,
          user_id: userIdStr,
          badge_id: 'encora_linked',
          connection_id: connectionId,
          domain: domain
        }));
      } catch (err) {
        console.error('[plugin-encora-linking] link-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // Unlink Encora endpoint
  if (pathname === '/api/admin/users/unlink-encora' ||
      pathname === '/custom-badges/api/unlink-encora' ||
      pathname === '/admin/users/unlink-encora') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    if (req.method === 'DELETE' || req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^(Admin|Bearer)\s+/i, '').trim();
      const validToken = Boolean(token && ALLOWED_ADMIN_TOKENS.has(token));
      if (!validToken && !checkAdminAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const userIdStr = String(body.user_id || '').trim();
        if (!userIdStr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing user_id' }));
          return;
        }
        const partitionKey = JSON.stringify({ __fluxer_type: 'bigint', value: userIdStr });

        // 1. Remove from plugin_user_badges
        await pool.query(`
          DELETE FROM plugin_user_badges
          WHERE user_id = $1 AND badge_id = 'encora_linked';
        `, [userIdStr]);

        await refreshBadgesCache(true);

        // 2. Remove connection from user_connections
        await pool.query(`
          DELETE FROM fluxer_kv
          WHERE table_name = 'user_connections'
            AND partition_key = $1
            AND row_data->>'connection_type' = 'domain'
            AND lower(row_data->>'identifier') LIKE '%encora%';
        `, [partitionKey]);

        // 3. Clear custom_badge_url from users
        await pool.query(`
          UPDATE fluxer_kv
          SET row_data = (row_data - 'custom_badge_url') - 'custom_badge_link',
              updated_at = NOW()
          WHERE table_name = 'users' AND row_key = $1;
        `, [partitionKey]);

        // 4. Strip guild role from user in Encora Reprise server
        try {
          await new Promise((resolve) => {
            const r = https.request(`https://prelude.chat/api/guilds/${ENCORA_GUILD_ID}/members/${userIdStr}/roles/${ENCORA_LINKED_ROLE_ID}`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bot ${BOT_TOKEN}`,
                'User-Agent': 'Encora/1.0'
              }
            }, (res) => {
              res.resume();
              resolve();
            });
            r.on('error', (e) => {
              console.error('[plugin-encora-linking] Failed to strip guild role:', e.message);
              resolve();
            });
            r.end();
          });
        } catch (e) {
          console.error('[plugin-encora-linking] Failed to strip guild role:', e.message);
        }

        console.log(`[plugin-encora-linking] Unlinked Encora account for user ${userIdStr}`);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, user_id: userIdStr }));
      } catch (err) {
        console.error('[plugin-encora-linking] unlink-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // 404 for unknown paths
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[plugin-encora-linking] Listening on 0.0.0.0:${PORT}`);
  refreshBadgesCache().catch(() => {});
});
