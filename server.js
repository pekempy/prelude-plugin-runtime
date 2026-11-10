const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://app-proxy:8080';
const SCRIPT_PATH = path.join(__dirname, 'encora-badges.js');
const ADMIN_HTML_PATH = path.join(__dirname, 'admin.html');
const CATEGORIES_PATH = path.join(__dirname, 'discovery-categories.json');
const ADMIN_SECRET = process.env.FLUXER_ADMIN_SECRET_KEY_BASE || 'REDACTED_ADMIN_SECRET';
const ALLOWED_ADMIN_TOKENS = new Set([
  ADMIN_SECRET,
  'REDACTED_MANUAL_KEY'
]);
const BOT_TOKEN = 'REDACTED_BOT_TOKEN';
const ENCORA_GUILD_ID = '1518021155376594944';
const ENCORA_LINKED_ROLE_ID = '1518032794880573443';

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'fluxer',
  user: process.env.PGUSER || 'fluxer',
  password: process.env.PGPASSWORD,
});

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
    console.error('[plugin-runtime] Database query error:', err.message);
  }
  return badgesCache;
}

function loadCategories() {
  try {
    if (fs.existsSync(CATEGORIES_PATH)) {
      const list = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8'));
      if (Array.isArray(list)) {
        return list.map(c => ({
          id: Number(c.id),
          name: String(c.name || ''),
          isDefault: Number(c.id) <= 8,
          hidden: Boolean(c.hidden)
        }));
      }
    }
  } catch (e) {
    console.error('[plugin-runtime] Error reading categories:', e);
  }
  return [
    { id: 0, name: 'Gaming', isDefault: true, hidden: false },
    { id: 1, name: 'Music', isDefault: true, hidden: false },
    { id: 2, name: 'Entertainment', isDefault: true, hidden: false },
    { id: 3, name: 'Education', isDefault: true, hidden: false },
    { id: 4, name: 'Science & Technology', isDefault: true, hidden: false },
    { id: 5, name: 'Content Creator', isDefault: true, hidden: false },
    { id: 6, name: 'Anime & Manga', isDefault: true, hidden: false },
    { id: 7, name: 'Movies & TV', isDefault: true, hidden: false },
    { id: 8, name: 'Other', isDefault: true, hidden: false }
  ];
}

function saveCategories(categories) {
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2), 'utf8');
}

function checkAdminAuth(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (!match) return false;

  const cookieValue = match[1].trim();
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return false;
  const [data, signature] = parts;

  const expectedSig = crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
  if (signature !== expectedSig) return false;

  try {
    const session = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (now - session.createdAt > 7 * 24 * 3600) return false;
    return session;
  } catch (e) {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
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

  // Public Discovery Categories API (full list with hidden flags)
  if (pathname === '/custom-badges/categories.json') {
    const categories = loadCategories();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(categories));
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

  // Public Discovery Categories API (consumed by Fluxer app client)
  if (
    pathname === '/api/v1/discovery/categories' ||
    pathname === '/v1/discovery/categories' ||
    pathname === '/api/discovery/categories' ||
    pathname === '/discovery/categories'
  ) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }
    const categories = loadCategories()
      .filter(c => !c.hidden)
      .map(c => ({ id: c.id, name: c.name }));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(categories));
    return;
  }

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

        console.log(`[plugin-runtime] Linked Encora account: user ${userIdStr} -> ${domain}`);

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
        console.error('[plugin-runtime] link-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }

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
              console.error('[plugin-runtime] Failed to strip guild role:', e.message);
              resolve();
            });
            r.end();
          });
        } catch (e) {
          console.error('[plugin-runtime] Failed to strip guild role:', e.message);
        }

        console.log(`[plugin-runtime] Unlinked Encora account for user ${userIdStr}`);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ success: true, user_id: userIdStr }));
      } catch (err) {
        console.error('[plugin-runtime] unlink-encora error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }
  // --- Preview proxy: inject custom badges into POST /api(.../v1)?/users/@me/profile-badges/preview ---
  const previewMatch = req.method === 'POST' && /^\/api(?:\/v\d+)?\/users\/@me\/profile-badges\/preview$/.test(pathname);
  if (previewMatch) {
    console.log(`[preview-proxy] hit: ${req.method} ${pathname}`);
    const API_URL = process.env.API_URL || 'http://api:8080';
    // Route preview POST through Caddy's internal port — it adds required forwarding headers
    const CADDY_INTERNAL = process.env.CADDY_INTERNAL_URL || 'http://caddy:8088';
    const caddyHost = new URL(CADDY_INTERNAL);
    // Keep full /api/... path — Caddy:8088 handles /api/* → api:8080
    const previewApiPath = pathname + (parsedUrl.search || '');

    // Decode user ID from JWT without verifying signature
    // Collect POST body FIRST before any async calls (stream must be read immediately)
    const bodyBuf = await new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // Resolve @me userId via GET /users/@me
    let previewUserId = null;
    try {
      const meRes = await new Promise((resolve, reject) => {
        const apiHost2 = new URL(API_URL);
        const r = http.request({
          hostname: apiHost2.hostname, port: parseInt(apiHost2.port||'80',10),
          path: '/users/@me', method: 'GET',
          headers: { ...req.headers, host: apiHost2.host, 'accept-encoding': 'identity' },
        }, resolve);
        r.on('error', reject); r.end();
      });
      let meBody = '';
      meRes.setEncoding('utf8');
      await new Promise(r => { meRes.on('data', c => meBody+=c); meRes.on('end', r); });
      const me = JSON.parse(meBody);
      previewUserId = String(me?.id || me?.user?.id || '');
    } catch (e) { console.log(`[preview-proxy] /users/@me error: ${e.message}`); }
    console.log(`[preview-proxy] resolved userId=${previewUserId} bodyLen=${bodyBuf.length}`);
    // Strip our custom badge keys from hidden_profile_badges before forwarding —
    // the Fluxer API rejects unknown badge keys with 400
    let customHiddenKeys = new Set();
    let cleanBuf = bodyBuf;
    try {
      const reqJson = JSON.parse(bodyBuf.toString('utf8'));
      if (Array.isArray(reqJson.hidden_profile_badges)) {
        const badgesMap0 = await refreshBadgesCache();
        const userBadges0 = previewUserId ? (badgesMap0.get(previewUserId) || []) : [];
        const customKeys = new Set(userBadges0.map(b => b.id));
        // Separate our keys from native keys
        reqJson.hidden_profile_badges.forEach(k => { if (customKeys.has(k)) customHiddenKeys.add(k); });
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

      const upstreamStatus = upstreamRes.statusCode;
      if (upstreamStatus !== 200) {
        let errBody = '';
        upstreamRes.setEncoding('utf8');
        await new Promise(r => { upstreamRes.on('data', c => errBody+=c); upstreamRes.on('end', r); });
        console.log(`[preview-proxy] upstream ${upstreamStatus}: ${errBody.slice(0,200)}`);
        console.log(`[preview-proxy] forwarded body: ${bodyBuf.toString('utf8').slice(0,200)}`);
        res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
        res.end(errBody);
        return;
      }

      let body = '';
      upstreamRes.setEncoding('utf8');
      await new Promise(resolve => { upstreamRes.on('data', c => { body += c; }); upstreamRes.on('end', resolve); });

      let data;
      try { data = JSON.parse(body); } catch { data = null; }
      if (data) console.log(`[preview-proxy] upstream own_badges=${data.own_badges?.length ?? 'missing'} profile_badges=${data.profile_badges?.length ?? 'missing'}`);
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
            hidden: customHiddenKeys.has(b.id),
            accessible_label: b.tooltip || b.name || b.id,
          }));
          // Inject into own_badges (shown in settings) — prepend custom badges
          const existing = data.own_badges || [];
          data.own_badges = [...injected, ...existing];
          console.log(`[preview-proxy] injected ${injected.length} badges into own_badges for ${previewUserId}`);
          body = JSON.stringify(data);
        }
      }

      const outHeaders = { ...upstreamRes.headers, 'content-type': 'application/json' };
      delete outHeaders['transfer-encoding'];
      outHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
      res.writeHead(200, outHeaders);
      res.end(body);
    } catch (err) {
      console.error('[plugin-runtime] Preview proxy error:', err.message);
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
        const userBadges = badgesMap.get(actualUserId) || [];
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
      console.error('[plugin-runtime] Profile proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Profile proxy error: ' + err.message);
    }
    return;
  }



  // Admin authentication guard for all /admin/plugins* routes
  if (pathname.startsWith('/admin/plugins') || pathname.startsWith('/admin/badges')) {
    const session = checkAdminAuth(req);
    if (!session) {
      const returnUrl = encodeURIComponent(req.url);
      res.writeHead(302, { 'Location': `/admin/login?return_to=${returnUrl}` });
      res.end();
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
            COALESCE(ub.custom_link, b.default_link) AS badge_link
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

        await pool.query(`
          INSERT INTO plugin_user_badges (user_id, badge_id, custom_link)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, badge_id) DO UPDATE SET
            custom_link = EXCLUDED.custom_link;
        `, [user_id, badge_id, linkToSave]);

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

        await pool.query(`
          DELETE FROM plugin_user_badges
          WHERE user_id = $1 AND badge_id = $2;
        `, [user_id, badge_id]);

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

    // --- Admin API: Discovery Categories ---
    if (pathname === '/admin/plugins/api/categories') {
      try {
        const categories = loadCategories();
        // Count assigned servers per category from PostgreSQL guild_discovery
        const countsRes = await pool.query(`
          SELECT (row_data->>'category_type')::int AS cat_id, COUNT(*) AS count
          FROM fluxer_kv
          WHERE table_name = 'guild_discovery'
            AND (row_data->>'status' = 'approved' OR row_data->>'status' IS NULL)
          GROUP BY (row_data->>'category_type')::int;
        `);
        const countMap = new Map();
        for (const row of countsRes.rows) {
          if (row.cat_id !== null && row.cat_id !== undefined) {
            countMap.set(row.cat_id, parseInt(row.count, 10));
          }
        }
        const result = categories.map(c => ({
          ...c,
          serverCount: countMap.get(c.id) || 0
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/categories/save' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { name } = body;
        if (!name || !name.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Category name is required' }));
          return;
        }

        const categories = loadCategories();
        let id = body.id;
        if (id === undefined || id === null || id === '') {
          const maxId = categories.reduce((max, c) => Math.max(max, c.id), 8);
          id = maxId + 1;
          categories.push({ id, name: name.trim(), isDefault: false, hidden: Boolean(body.hidden) });
        } else {
          id = parseInt(id, 10);
          const existingIdx = categories.findIndex(c => c.id === id);
          if (existingIdx >= 0) {
            categories[existingIdx].name = name.trim();
            if (body.hidden !== undefined) {
              categories[existingIdx].hidden = Boolean(body.hidden);
            }
          } else {
            categories.push({ id, name: name.trim(), isDefault: id <= 8, hidden: Boolean(body.hidden) });
          }
        }

        saveCategories(categories);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, categories }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/categories/toggle-hidden' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = parseInt(body.id, 10);
        if (isNaN(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid category ID required' }));
          return;
        }

        const categories = loadCategories();
        const cat = categories.find(c => c.id === id);
        if (!cat) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Category not found' }));
          return;
        }

        cat.hidden = body.hidden !== undefined ? Boolean(body.hidden) : !cat.hidden;
        saveCategories(categories);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, category: cat }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/categories/delete' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const id = parseInt(body.id, 10);
        if (isNaN(id) || id < 9) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Default categories (0-8) cannot be deleted; hide them instead.' }));
          return;
        }

        let categories = loadCategories();
        categories = categories.filter(c => c.id !== id);
        saveCategories(categories);

        // Move any guilds assigned to this deleted category to Other (ID 8)
        await pool.query(`
          UPDATE fluxer_kv
          SET row_data = jsonb_set(row_data, '{category_type}', '8'::jsonb),
              updated_at = NOW()
          WHERE table_name = 'guild_discovery'
            AND (row_data->>'category_type')::int = $1;
        `, [id]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, categories }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Admin API: Guild Discovery Assignment ---
    if (pathname === '/admin/plugins/api/guilds') {
      try {
        const result = await pool.query(`
          SELECT 
            g.partition_key::jsonb->>'value' AS id,
            g.row_data->>'name' AS name,
            g.row_data->>'icon' AS icon,
            g.row_data->>'description' AS description,
            d.row_data->>'status' AS discovery_status,
            (d.row_data->>'category_type')::int AS category_id
          FROM fluxer_kv g
          LEFT JOIN fluxer_kv d 
            ON d.table_name = 'guild_discovery' 
            AND d.partition_key::jsonb->>'value' = g.partition_key::jsonb->>'value'
          WHERE g.table_name = 'guilds'
          ORDER BY g.row_data->>'name';
        `);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          guilds: result.rows.map(r => ({
            id: r.id,
            name: r.name,
            icon: r.icon,
            description: r.description,
            inDiscovery: Boolean(r.discovery_status),
            discoveryStatus: r.discovery_status || null,
            categoryId: r.category_id !== null ? r.category_id : null
          }))
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname.match(/^\/admin\/plugins\/api\/categories\/(\d+)\/guilds$/)) {
      const match = pathname.match(/^\/admin\/plugins\/api\/categories\/(\d+)\/guilds$/);
      const catId = parseInt(match[1], 10);
      try {
        const result = await pool.query(`
          SELECT 
            g.partition_key::jsonb->>'value' AS id,
            g.row_data->>'name' AS name,
            g.row_data->>'icon' AS icon,
            g.row_data->>'description' AS description,
            d.row_data->>'status' AS discovery_status,
            (d.row_data->>'category_type')::int AS category_id
          FROM fluxer_kv g
          JOIN fluxer_kv d 
            ON d.table_name = 'guild_discovery' 
            AND d.partition_key::jsonb->>'value' = g.partition_key::jsonb->>'value'
          WHERE g.table_name = 'guilds'
            AND (d.row_data->>'category_type')::int = $1
          ORDER BY g.row_data->>'name';
        `, [catId]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          categoryId: catId,
          guilds: result.rows.map(r => ({
            id: r.id,
            name: r.name,
            icon: r.icon,
            description: r.description,
            inDiscovery: true,
            discoveryStatus: r.discovery_status,
            categoryId: r.category_id
          }))
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/categories/assign-guild' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { guild_id, category_id } = body;
        if (!guild_id || category_id === undefined || category_id === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'guild_id and category_id are required' }));
          return;
        }

        const catId = parseInt(category_id, 10);
        const guildId = String(guild_id).trim();

        // Check if guild exists
        const guildRes = await pool.query(`
          SELECT row_data FROM fluxer_kv
          WHERE table_name = 'guilds' AND partition_key::jsonb->>'value' = $1;
        `, [guildId]);

        if (guildRes.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Guild not found' }));
          return;
        }

        const guildData = guildRes.rows[0].row_data;
        const guildName = guildData?.name || 'Server';
        const guildDesc = guildData?.description || guildName;

        // Check if already in guild_discovery
        const discRes = await pool.query(`
          SELECT row_data FROM fluxer_kv
          WHERE table_name = 'guild_discovery' AND partition_key::jsonb->>'value' = $1;
        `, [guildId]);

        const nowIso = new Date().toISOString();

        if (discRes.rows.length > 0) {
          // Already in discovery: update category_type and ensure status is approved
          await pool.query(`
            UPDATE fluxer_kv
            SET row_data = jsonb_set(
                  jsonb_set(row_data, '{category_type}', to_jsonb($1::int)),
                  '{status}', '"approved"'
                ),
                updated_at = NOW()
            WHERE table_name = 'guild_discovery'
              AND partition_key::jsonb->>'value' = $2;
          `, [catId, guildId]);
        } else {
          // Not yet in discovery: insert into guild_discovery AND guild_discovery_by_status
          const discoveryRowData = {
            status: 'approved',
            guild_id: { value: guildId, __fluxer_type: 'bigint' },
            applied_at: { value: nowIso, __fluxer_type: 'date' },
            reviewed_at: { value: nowIso, __fluxer_type: 'date' },
            reviewed_by: { value: '1518020854590472192', __fluxer_type: 'bigint' },
            category_type: catId,
            primary_language: 'en-US',
            custom_tags: [],
            description: guildDesc,
            removed_at: null,
            removed_by: null,
            review_reason: null,
            removal_reason: null
          };

          const statusRowKey = `"approved"\x1F{"__fluxer_type":"date","value":"${nowIso}"}\x1F{"__fluxer_type":"bigint","value":"${guildId}"}`;
          const statusRowData = {
            status: 'approved',
            guild_id: { value: guildId, __fluxer_type: 'bigint' },
            applied_at: { value: nowIso, __fluxer_type: 'date' }
          };

          const pk = JSON.stringify({ __fluxer_type: 'bigint', value: guildId });
          await pool.query(`
            INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, updated_at)
            VALUES (
              'guild_discovery',
              $1,
              $1,
              $2::jsonb,
              NOW()
            );
          `, [pk, JSON.stringify(discoveryRowData)]);

          await pool.query(`
            INSERT INTO fluxer_kv (table_name, partition_key, row_key, row_data, updated_at)
            VALUES (
              'guild_discovery_by_status',
              '"approved"',
              $1,
              $2::jsonb,
              NOW()
            )
            ON CONFLICT (table_name, row_key) DO UPDATE SET row_data = EXCLUDED.row_data, updated_at = NOW();
          `, [statusRowKey, JSON.stringify(statusRowData)]);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (pathname === '/admin/plugins/api/categories/remove-guild' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const { guild_id } = body;
        if (!guild_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'guild_id is required' }));
          return;
        }

        const guildId = String(guild_id).trim();

        await pool.query(`
          DELETE FROM fluxer_kv
          WHERE table_name = 'guild_discovery'
            AND partition_key::jsonb->>'value' = $1;
        `, [guildId]);

        await pool.query(`
          DELETE FROM fluxer_kv
          WHERE table_name = 'guild_discovery_by_status'
            AND row_key LIKE $1;
        `, [`%${guildId}%`]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Serve Admin HTML Dashboard
    try {
      const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to render admin page: ' + err.message);
    }
    return;
  }
  // --- API passthrough: any /api/* not handled above goes straight to api:8080 ---
  if (pathname.startsWith('/api/')) {
    const API_URL = process.env.API_URL || 'http://api:8080';
    const apiHost = new URL(API_URL);
    const apiPath = pathname.replace(/^\/api/, '') + (parsedUrl.search || '');
    const proxyReq = http.request({
      hostname: apiHost.hostname,
      port: parseInt(apiHost.port || '80', 10),
      path: apiPath,
      method: req.method,
      headers: { ...req.headers, host: apiHost.host, 'accept-encoding': 'identity' },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      console.error('[plugin-runtime] API passthrough error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('API proxy error: ' + err.message);
    });
    req.pipe(proxyReq);
    return;
  }


  // --- Fallback: Proxy to UPSTREAM_URL (app-proxy:8080) with script injection ---
  try {
    const upstreamUrl = new URL(req.url, UPSTREAM_URL);
    const clientReq = http.request(upstreamUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: upstreamUrl.host,
        'accept-encoding': 'identity', // Uncompressed for script injection
      }
    }, (upstreamRes) => {
      const contentType = upstreamRes.headers['content-type'] || '';
      if (contentType.includes('text/html')) {
        let body = '';
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', chunk => { body += chunk; });
        upstreamRes.on('end', () => {
          const scriptTag = '<script src="/custom-badges/encora-badges.js?v=2.4.0" defer></script>';
          let modified = body;
          if (body.includes('</body>')) {
            modified = body.replace('</body>', `${scriptTag}</body>`);
          } else {
            modified = body + scriptTag;
          }

          const outHeaders = { ...upstreamRes.headers };
          delete outHeaders['content-length'];
          outHeaders['content-length'] = Buffer.byteLength(modified, 'utf8');

          res.writeHead(upstreamRes.statusCode, outHeaders);
          res.end(modified);
        });
      } else {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    });

    clientReq.on('error', (err) => {
      console.error('[plugin-runtime] Upstream app-proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: Upstream app-proxy unavailable');
    });

    req.pipe(clientReq);
  } catch (err) {
    console.error('[plugin-runtime] Proxy fatal error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[plugin-runtime] Unified plugin runtime listening on 0.0.0.0:${PORT}, upstream: ${UPSTREAM_URL}`);
  refreshBadgesCache().catch(() => {});
});
