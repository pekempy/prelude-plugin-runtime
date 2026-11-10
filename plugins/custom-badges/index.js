const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createPool } = require('../../shared/pg');
const { checkAdminAuth, ADMIN_SECRET, ALLOWED_ADMIN_TOKENS } = require('../../shared/auth');
const { readJsonBody, readRawBody, json } = require('../../shared/http');
const {
  addBadgeRoleLink,
  ensureRoleLinkSchema,
  fetchBotGuildRoles,
  fetchBotGuilds,
  getBadgeRoleLinks,
  removeBadgeRoleLink,
  syncMemberRoleSnapshot,
} = require('./role-links');
const { isBadgeSyncAuthorized, normalizeRoleSyncSnapshot } = require('./role-sync');

const PORT = parseInt(process.env.PORT || '8081', 10);
const SCRIPT_PATH = path.join(__dirname, 'encora-badges.js');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BADGE_SYNC_TOKEN = process.env.BADGE_SYNC_TOKEN || BOT_TOKEN;
const BOT_API_URL = `${(process.env.CADDY_INTERNAL_URL || 'http://caddy:8088').replace(/\/+$/, '')}/api`;
const ENCORA_GUILD_ID = '1518021155376594944';
const ENCORA_LINKED_ROLE_ID = '1518032794880573443';

const pool = createPool();

// --- Auth token → userId cache (avoids GET /users/@me on every preview request) ---
const _authUserCache = new Map(); // tokenHash → { userId, ts }
const AUTH_CACHE_TTL = 600_000; // 10 min
function _hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex').slice(0,16); }
async function _resolveUserId(authHeader, caddyUrl) {
  const token = (authHeader || '').replace(/^Bearer\s+/i,'').trim();
  if (!token) return null;
  const h = _hashToken(token);
  const cached = _authUserCache.get(h);
  if (cached && Date.now() - cached.ts < AUTH_CACHE_TTL) return cached.userId;
  try {
    const caddyHost = new URL(caddyUrl);
    // Route through Caddy:8088 — same as the main proxy path, handles auth correctly
    for (const mePath of ['/api/v1/users/@me', '/api/users/@me']) {
      const meRes = await new Promise((resolve, reject) => {
        const r = http.request({ hostname: caddyHost.hostname, port: parseInt(caddyHost.port||'8088',10),
          path: mePath, method: 'GET',
          headers: { 'authorization': authHeader, host: caddyHost.host, 'accept-encoding': 'identity' },
        }, resolve);
        r.on('error', reject); r.end();
      });
      let meBody = '';
      meRes.setEncoding('utf8');
      await new Promise(r => { meRes.on('data', c => meBody+=c); meRes.on('end', r); });
      if (meRes.statusCode === 200) {
        const me = JSON.parse(meBody);
        const userId = String(me?.id || me?.user?.id || '');
        if (userId) { _authUserCache.set(h, { userId, ts: Date.now() }); return userId; }
      }
    }
    return null;
  } catch { return null; }
}

// --- Custom badge hidden state (per-user, persisted to DB) ---
// In-memory: Map<userId, Map<badgeKey, hidden>>
const _customHiddenState = new Map();
async function _getCustomHidden(userId) {
  if (_customHiddenState.has(userId)) return _customHiddenState.get(userId);
  // Load from DB
  const m = new Map();
  try {
    const r = await pool.query(`SELECT badge_id, hidden FROM plugin_user_badges WHERE user_id = $1`, [userId]);
    for (const row of r.rows) m.set(row.badge_id, Boolean(row.hidden));
  } catch {}
  _customHiddenState.set(userId, m);
  return m;
}
async function _setCustomHidden(userId, badgeKey, hidden) {
  const m = await _getCustomHidden(userId);
  m.set(badgeKey, hidden);
  // Persist asynchronously
  pool.query(`UPDATE plugin_user_badges SET hidden = $1 WHERE user_id = $2 AND badge_id = $3`, [hidden, userId, badgeKey]).catch(() => {});
}

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
    console.error('[plugin-custom-badges] Database query error:', err.message);
  }
  return badgesCache;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Remote telemetry log from client browser
  if (pathname === '/custom-badges/log') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      console.log(`[CLIENT LOG] ${body}`);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
    return;
  }

  // Same-origin image proxy to bypass strict CSP / hotlink blocking
  if (pathname === '/custom-badges/image-proxy') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid url');
      return;
    }
    const client = targetUrl.startsWith('https://') ? https : http;
    const imgReq = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    }, (imgRes) => {
      if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
        const redirectUrl = new URL(imgRes.headers.location, targetUrl).toString();
        res.writeHead(302, { 'Location': `/custom-badges/image-proxy?url=${encodeURIComponent(redirectUrl)}` });
        res.end();
        return;
      }
      res.writeHead(imgRes.statusCode || 200, {
        'Content-Type': imgRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      imgRes.pipe(res);
    });
    imgReq.on('error', (err) => {
      console.error('[image-proxy] Proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to proxy image');
    });
    return;
  }

  // Health check
  if (pathname === '/custom-badges/health' || pathname === '/admin/plugins/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', badgesCount: badgesCache.size }));
    return;
  }

  // Client script
  if (pathname === '/custom-badges/encora-badges.js') {
    try {
      const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(script);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to read script: ' + err.message);
    }
    return;
  }

  // All badges JSON (supports multiple badges per user)
  if (pathname === '/custom-badges/badges.json') {
    const badges = await refreshBadgesCache();
    const obj = Object.fromEntries(badges);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj));
    return;
  }

  // Public Custom Badges API per user (REST)
  if (pathname.startsWith('/api/custom/badges/')) {
    const targetUserId = pathname.replace('/api/custom/badges/', '').trim();
    const badges = await refreshBadgesCache();
    const userBadges = badges.get(targetUserId) || [];
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ user_id: targetUserId, badges: userBadges }));
    return;
  }

  // Link Encora
  if (
    pathname === '/api/admin/users/link-encora' ||
    pathname === '/custom-badges/api/link-encora' ||
    pathname === '/admin/users/link-encora'
  ) {
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
          INSERT INTO plugin_user_badges (user_id, badge_id, custom_link, role_managed)
          VALUES ($1, 'encora_linked', $2, FALSE)
          ON CONFLICT (user_id, badge_id) DO UPDATE SET
            custom_link = EXCLUDED.custom_link,
            role_managed = FALSE;
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

        console.log(`[plugin-custom-badges] Linked Encora account: user ${userIdStr} -> ${domain}`);

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
        console.error('[plugin-custom-badges] link-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // Unlink Encora
  if (
    pathname === '/api/admin/users/unlink-encora' ||
    pathname === '/custom-badges/api/unlink-encora' ||
    pathname === '/admin/users/unlink-encora'
  ) {
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
              console.error('[plugin-custom-badges] Failed to strip guild role:', e.message);
              resolve();
            });
            r.end();
          });
        } catch (e) {
          console.error('[plugin-custom-badges] Failed to strip guild role:', e.message);
        }

        console.log(`[plugin-custom-badges] Unlinked Encora account for user ${userIdStr}`);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, user_id: userIdStr }));
      } catch (err) {
        console.error('[plugin-custom-badges] unlink-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // --- Preview proxy: inject custom badges into POST /api(.../v1)?/users/@me/profile-badges/preview ---
  const previewMatch = req.method === 'POST' && /^\/api(?:\/v\d+)?\/users\/@me\/profile-badges\/preview$/.test(pathname);
  if (previewMatch) {
    console.log(`[preview-proxy] ${req.method} ${pathname}`);
    const API_URL = process.env.API_URL || 'http://api:8080';
    const CADDY_INTERNAL = process.env.CADDY_INTERNAL_URL || 'http://caddy:8088';
    const caddyHost = new URL(CADDY_INTERNAL);
    const previewApiPath = pathname + (parsedUrl.search || '');

    // Collect POST body FIRST before any async calls
    const bodyBuf = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // Resolve userId (cached — no extra round trip after first request)
    const previewUserId = await _resolveUserId(req.headers['authorization'] || '', CADDY_INTERNAL);
    console.log(`[preview-proxy] userId=${previewUserId}`);

    // Load persisted hidden state for this user's custom badges
    const hiddenState = previewUserId ? await _getCustomHidden(previewUserId) : new Map();

    // Detect if Flutter sent any of our custom badge keys in hidden_profile_badges
    // Strip them before forwarding (Fluxer API rejects unknown keys with 400)
    let cleanBuf = bodyBuf;
    try {
      const reqJson = JSON.parse(bodyBuf.toString('utf8'));
      if (Array.isArray(reqJson.hidden_profile_badges) && previewUserId) {
        const badgesMap0 = await refreshBadgesCache();
        const customKeys = new Set((badgesMap0.get(previewUserId) || []).map(b => b.id));
        // Update persisted state from request
        for (const k of customKeys) {
          const nowHidden = reqJson.hidden_profile_badges.includes(k);
          if (hiddenState.get(k) !== nowHidden) {
            await _setCustomHidden(previewUserId, k, nowHidden);
            hiddenState.set(k, nowHidden);
          }
        }
        reqJson.hidden_profile_badges = reqJson.hidden_profile_badges.filter(k => !customKeys.has(k));
        cleanBuf = Buffer.from(JSON.stringify(reqJson), 'utf8');
      }
    } catch {}

    try {
      const upstreamRes = await new Promise((resolve, reject) => {
        const proxyReq = http.request({
          hostname: caddyHost.hostname,
          port: parseInt(caddyHost.port || '8088', 10),
          path: previewApiPath,
          method: 'POST',
          headers: { ...req.headers, host: caddyHost.host, 'accept-encoding': 'identity', 'content-length': String(cleanBuf.length) },
        }, resolve);
        proxyReq.on('error', reject);
        proxyReq.end(cleanBuf);
      });

      console.log(`[preview-proxy] upstream status=${upstreamRes.statusCode}`);
      if (upstreamRes.statusCode !== 200) {
        let errBody = '';
        upstreamRes.setEncoding('utf8');
        await new Promise(r => { upstreamRes.on('data', c => errBody+=c); upstreamRes.on('end', r); });
        res.writeHead(upstreamRes.statusCode, { 'content-type': 'application/json' });
        res.end(errBody);
        return;
      }

      let body = '';
      upstreamRes.setEncoding('utf8');
      await new Promise(resolve => { upstreamRes.on('data', c => { body += c; }); upstreamRes.on('end', resolve); });

      let data;
      try { data = JSON.parse(body); } catch { data = null; }

      // Inject custom badges into own_badges so they appear in the settings list.
      // Toggle is non-functional (Flutter's kProfileBadgeKinds guard ignores taps on "custom" kind)
      // — that's the closest to "disabled" achievable server-side.
      if (data && previewUserId) {
        const badgesMap = await refreshBadgesCache();
        const userBadges = badgesMap.get(previewUserId) || [];
        if (userBadges.length > 0) {
          const domain = process.env.FLUXER_DOMAIN ? `https://${process.env.FLUXER_DOMAIN}` : 'https://prelude.chat';
          const injected = userBadges.map(b => ({
            key: b.id,
            kind: 'custom',
            label: b.name || b.tooltip || b.id,
            asset: null,
            asset_url: b.icon ? `${domain}/custom-badges/image-proxy?url=${encodeURIComponent(b.icon)}` : null,
            aspect_ratio: null,
            caption: null,
            href: b.link || null,
            hidden: hiddenState.get(b.id) ?? false,
            accessible_label: b.tooltip || b.name || b.id,
          }));
          data.own_badges = [...injected, ...(data.own_badges || [])];
          body = JSON.stringify(data);
        }
      }

      const outHeaders = { ...upstreamRes.headers, 'content-type': 'application/json' };
      delete outHeaders['transfer-encoding'];
      outHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
      res.writeHead(200, outHeaders);
      res.end(body);
    } catch (err) {
      console.error('[plugin-custom-badges] Preview proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Preview proxy error: ' + err.message);
    }
    return;
  }

  // --- Profile proxy: inject custom badges into GET /api/v1/users/:userId/profile ---
  const profilePathMatch = req.method === 'GET' && pathname.match(/^\/api(?:\/v\d+)?\/users\/([^/]+)\/profile$/);
  if (profilePathMatch) {
    const userIdParam = profilePathMatch[1];
    const API_URL = process.env.API_URL || 'http://api:8080';
    // Strip /api prefix — api:8080 serves routes without it
    const apiPath = pathname.replace(/^\/api/, '') + (parsedUrl.search || '');
    try {
      const apiHost = new URL(API_URL);
      const upstreamRes = await new Promise((resolve, reject) => {
        const proxyReq = http.request({
          hostname: apiHost.hostname,
          port: parseInt(apiHost.port || '80', 10),
          path: apiPath,
          method: 'GET',
          headers: { ...req.headers, host: apiHost.host, 'accept-encoding': 'identity' },
        }, resolve);
        proxyReq.on('error', reject);
        proxyReq.end();
      });

      console.log(`[profile-proxy] ${req.method} ${pathname} → upstream status ${upstreamRes.statusCode}`);
      if (upstreamRes.statusCode !== 200) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      let body = '';
      upstreamRes.setEncoding('utf8');
      await new Promise(resolve => { upstreamRes.on('data', c => { body += c; }); upstreamRes.on('end', resolve); });

      let data;
      try { data = JSON.parse(body); } catch { data = null; }

      if (data) {
        const actualUserId = String(data?.user?.id || userIdParam);
        const badgesMap = await refreshBadgesCache();
        const hiddenMap = await _getCustomHidden(actualUserId);
        const userBadges = (badgesMap.get(actualUserId) || []).filter(b => !(hiddenMap.get(b.id) ?? false));
        if (userBadges.length) console.log(`[profile-proxy] injecting ${userBadges.length} badges for ${actualUserId}`);

        if (userBadges.length > 0) {
          const domain = process.env.FLUXER_DOMAIN ? `https://${process.env.FLUXER_DOMAIN}` : 'https://prelude.chat';
          const injected = userBadges.map(b => {
            const rawIcon = b.icon || '';
            // Route through image proxy so CSP passes on both web and mobile
            const assetUrl = rawIcon ? `${domain}/custom-badges/image-proxy?url=${encodeURIComponent(rawIcon)}` : null;
            return {
              key: b.id,
              kind: 'custom',
              label: b.name || b.tooltip || b.id,
              asset: null,
              asset_url: assetUrl,
              small_asset: null,
              aspect_ratio: null,
              caption: null,
              href: b.link || null,
              accessible_label: b.tooltip || b.name || b.id,
              count: null,
              details: null,
              quote: null,
            };
          });

          // Handle both snake_case and camelCase API responses
          if ('profile_badges' in data) {
            data.profile_badges = [...injected, ...(data.profile_badges || [])];
          } else if ('profileBadges' in data) {
            data.profileBadges = [...injected, ...(data.profileBadges || [])];
          } else {
            data.profile_badges = injected;
          }
        }
        body = JSON.stringify(data);
      }

      const outHeaders = { ...upstreamRes.headers, 'content-type': 'application/json' };
      delete outHeaders['transfer-encoding'];
      outHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
      res.writeHead(200, outHeaders);
      res.end(body);
    } catch (err) {
      console.error('[plugin-custom-badges] Profile proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Profile proxy error: ' + err.message);
    }
    return;
  }

  if (pathname === '/admin/plugins/api/badges/role-sync' && req.method === 'POST') {
    if (!BADGE_SYNC_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Badge role sync is not configured' }));
      return;
    }

    if (!isBadgeSyncAuthorized(req.headers.authorization || '', BADGE_SYNC_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const snapshot = normalizeRoleSyncSnapshot(await readJsonBody(req));
      if (!snapshot) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid guild_id, user_id, or role_ids' }));
        return;
      }

      const badgeIds = await syncMemberRoleSnapshot(pool, snapshot);
      await refreshBadgesCache(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, badge_ids: badgeIds }));
    } catch (err) {
      console.error('[plugin-custom-badges] Role sync failed:', err.message);
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.status ? err.message : 'Role sync failed' }));
    }
    return;
  }

  // Admin authentication guard for all /admin/plugins/api/badges routes
  if (pathname.startsWith('/admin/plugins/api/badges') || pathname.startsWith('/admin/plugins/api/users')) {
    const session = checkAdminAuth(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (pathname === '/admin/plugins/api/badges/guilds' && req.method === 'GET') {
      try {
        const guilds = await fetchBotGuilds(BOT_API_URL, BOT_TOKEN);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(guilds));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const guildRolesMatch = pathname.match(/^\/admin\/plugins\/api\/badges\/guilds\/([^/]+)\/roles$/);
    if (guildRolesMatch && req.method === 'GET') {
      try {
        const roles = await fetchBotGuildRoles(BOT_API_URL, BOT_TOKEN, decodeURIComponent(guildRolesMatch[1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(roles));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const badgeRoleLinksMatch = pathname.match(/^\/admin\/plugins\/api\/badges\/([^/]+)\/role-links$/);
    if (badgeRoleLinksMatch && req.method === 'GET') {
      try {
        const badgeId = decodeURIComponent(badgeRoleLinksMatch[1]);
        const badge = await pool.query('SELECT id FROM plugin_custom_badges WHERE id = $1', [badgeId]);
        if (!badge.rows.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Badge not found' }));
          return;
        }

        const links = await getBadgeRoleLinks(pool, badgeId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ links }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (badgeRoleLinksMatch && req.method === 'POST') {
      try {
        const badgeId = decodeURIComponent(badgeRoleLinksMatch[1]);
        const body = await readJsonBody(req);
        const link = await addBadgeRoleLink(pool, {
          badgeId,
          guildId: String(body.guild_id || ''),
          roleId: String(body.role_id || ''),
        }, { apiUrl: BOT_API_URL, botToken: BOT_TOKEN });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, link }));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const deleteBadgeRoleLinkMatch = pathname.match(/^\/admin\/plugins\/api\/badges\/([^/]+)\/role-links\/([^/]+)$/);
    if (deleteBadgeRoleLinkMatch && req.method === 'DELETE') {
      try {
        const badgeId = decodeURIComponent(deleteBadgeRoleLinkMatch[1]);
        const removed = await removeBadgeRoleLink(pool, badgeId, deleteBadgeRoleLinkMatch[2]);
        if (! removed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Linked role not found' }));
          return;
        }

        await refreshBadgesCache(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Admin API: Badges Catalog & Users ---
    if (pathname === '/admin/plugins/api/badges/list') {
      try {
        const resBadges = await pool.query(`
          SELECT 
            b.id,
            b.name,
            b.icon_url AS icon,
            b.description,
            b.default_link AS "defaultLink",
            COALESCE(b.tooltip, b.name) AS tooltip,
            COUNT(ub.user_id)::int AS "userCount"
          FROM plugin_custom_badges b
          LEFT JOIN plugin_user_badges ub ON ub.badge_id = b.id
          GROUP BY b.id, b.name, b.icon_url, b.description, b.default_link, b.tooltip, b.created_at
          ORDER BY b.created_at ASC;
        `);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resBadges.rows));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.startsWith('/admin/plugins/api/badges/') && pathname.endsWith('/users')) {
      const badgeId = pathname.replace('/admin/plugins/api/badges/', '').replace('/users', '');
      try {
        const badgeRes = await pool.query(
          `SELECT id, name, icon_url AS icon, description, default_link AS "defaultLink", tooltip FROM plugin_custom_badges WHERE id = $1`,
          [badgeId]
        );
        if (!badgeRes.rows.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Badge not found' }));
          return;
        }
        const badge = badgeRes.rows[0];
        const usersRes = await pool.query(`
          SELECT 
            ub.user_id,
            u.row_data->>'username' AS username,
            u.row_data->>'avatar' AS avatar,
            b.icon_url AS badge_url,
            COALESCE(ub.custom_link, b.default_link) AS badge_link,
            ub.role_managed
          FROM plugin_user_badges ub
          JOIN plugin_custom_badges b ON ub.badge_id = b.id
          LEFT JOIN fluxer_kv u ON u.table_name = 'users' AND (u.partition_key::jsonb->>'value') = ub.user_id
          WHERE ub.badge_id = $1
          ORDER BY u.row_data->>'username' ASC;
        `, [badgeId]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          badge,
          users: usersRes.rows
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/users/search') {
      const q = (parsedUrl.searchParams.get('q') || '').trim();
      if (!q) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }

      try {
        const searchRes = await pool.query(`
          SELECT 
            partition_key::jsonb->>'value' AS user_id,
            row_data->>'username' AS username,
            row_data->>'discriminator' AS discriminator,
            row_data->>'avatar' AS avatar
          FROM fluxer_kv
          WHERE table_name = 'users'
            AND (
              row_data->>'username' ILIKE $1 
              OR partition_key::jsonb->>'value' = $2
            )
          LIMIT 15;
        `, [`%${q}%`, q]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(searchRes.rows));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/badges/assign-user' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { user_id, badge_id, badge_link } = body;
        if (!user_id || !badge_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing user_id or badge_id' }));
          return;
        }

        const badgeRes = await pool.query(`SELECT id, default_link FROM plugin_custom_badges WHERE id = $1`, [badge_id]);
        if (!badgeRes.rows.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Badge not found' }));
          return;
        }
        const badge = badgeRes.rows[0];
        const linkToSave = badge_link || badge.default_link || null;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [String(user_id)]);
          await client.query(`
            INSERT INTO plugin_user_badges (user_id, badge_id, custom_link, role_managed)
            VALUES ($1, $2, $3, FALSE)
            ON CONFLICT (user_id, badge_id) DO UPDATE SET
              custom_link = EXCLUDED.custom_link,
              role_managed = FALSE;
          `, [user_id, badge_id, linkToSave]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }

        await refreshBadgesCache(true);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/badges/remove-user' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { user_id, badge_id } = body;
        if (!user_id || !badge_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing user_id or badge_id' }));
          return;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [String(user_id)]);
          const roleAssignments = await client.query(`
            SELECT 1
            FROM plugin_user_badge_role_assignments AS assignment
            JOIN plugin_badge_role_links AS link ON link.id = assignment.role_link_id
            WHERE assignment.user_id = $1 AND link.badge_id = $2
            LIMIT 1;
          `, [user_id, badge_id]);

          if (roleAssignments.rows.length) {
            await client.query('ROLLBACK');
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'This badge is currently assigned by a linked role' }));
            return;
          }

          await client.query(`
            DELETE FROM plugin_user_badges
            WHERE user_id = $1 AND badge_id = $2;
          `, [user_id, badge_id]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }


        await refreshBadgesCache(true);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/badges/create' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { name, icon, description, defaultLink, tooltip } = body;
        if (!name || !icon) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Name and icon are required' }));
          return;
        }

        const id = (body.id || name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')).trim();
        const result = await pool.query(`
          INSERT INTO plugin_custom_badges (id, name, icon_url, tooltip, default_link, description)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            icon_url = EXCLUDED.icon_url,
            tooltip = EXCLUDED.tooltip,
            default_link = EXCLUDED.default_link,
            description = EXCLUDED.description
          RETURNING *;
        `, [id, name.trim(), icon.trim(), tooltip || name.trim(), defaultLink || '', description || '']);

        await refreshBadgesCache(true);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, badge: result.rows[0] }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

(async () => {
  try {
    await ensureRoleLinkSchema(pool);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[plugin-custom-badges] listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('[plugin-custom-badges] Failed to initialize role-link schema:', err.message);
    await pool.end();
    process.exitCode = 1;
  }
})();

process.on('SIGTERM', async () => {
  console.log('[plugin-custom-badges] SIGTERM received, closing...');
  await pool.end();
  process.exit(0);
});
