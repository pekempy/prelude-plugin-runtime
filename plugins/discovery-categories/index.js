const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPool } = require('../../shared/pg');
const { checkAdminAuth, ADMIN_SECRET } = require('../../shared/auth');
const { readJsonBody, json } = require('../../shared/http');

const PORT = parseInt(process.env.PORT || '8082', 10);
const CATEGORIES_PATH = path.join(__dirname, 'discovery-categories.json');
const pool = createPool();

// --- Load and Save Categories ---
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
    console.error('[discovery-categories] Error reading categories:', e);
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

const server = http.createServer(async (req, res) => {
  const { pathname, search } = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers for all responses
  const setCorsHeaders = (headers) => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers
  });

  // Public Categories JSON endpoint (migrated from custom-badges)
  if (pathname === '/categories/categories.json' || pathname === '/custom-badges/categories.json') {
    const categories = loadCategories();
    res.writeHead(200, setCorsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }));
    res.end(JSON.stringify(categories));
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
      res.writeHead(204, setCorsHeaders({}));
      res.end();
      return;
    }
    const categories = loadCategories()
      .filter(c => !c.hidden)
      .map(c => ({ id: c.id, name: c.name }));
    res.writeHead(200, setCorsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }));
    res.end(JSON.stringify(categories));
    return;
  }

  // --- Admin API: Discovery Categories (with auth) ---
  if (pathname === '/admin/plugins/api/categories') {
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
    const auth = checkAdminAuth(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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

  // 404 for unhandled routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[discovery-categories] listening on port ${PORT}`);
});
