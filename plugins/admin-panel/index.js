const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { checkAdminAuth, createSessionCookie, ADMIN_SECRET } = require('../../shared/auth.js');
const { json } = require('../../shared/http.js');

const PORT = parseInt(process.env.PORT || '8084', 10);
const ADMIN_HTML_PATH = path.join(__dirname, 'admin.html');

// Simple login form HTML
const LOGIN_FORM = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fluxer Admin Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-container {
      background: white;
      border-radius: 8px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      width: 100%;
      max-width: 400px;
      padding: 40px;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 10px;
      color: #222;
      text-align: center;
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .error {
      background-color: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .error.show { display: block; }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      color: #333;
      font-weight: 500;
      font-size: 14px;
    }
    input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    button {
      width: 100%;
      padding: 10px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #5568d3;
    }
    button:active {
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <h1>Fluxer Admin</h1>
    <p class="subtitle">Plugins Manager</p>
    <div class="error" id="error"></div>
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus>
      </div>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
      document.getElementById('error').textContent = 'Invalid password';
      document.getElementById('error').classList.add('show');
    }
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const search = parsedUrl.search;

  // Health check
  if (pathname === '/admin/plugins/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // Login page (GET)
  if (pathname === '/admin/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_FORM);
    return;
  }

  // Login submit (POST)
  if (pathname === '/admin/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const password = params.get('password') || '';
        
        if (password === ADMIN_SECRET) {
          const sessionCookie = createSessionCookie('admin');
          res.writeHead(302, {
            'Set-Cookie': `admin_session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
            'Location': '/admin/plugins'
          });
          res.end();
        } else {
          res.writeHead(302, { 'Location': '/admin/login?error=invalid' });
          res.end();
        }
      } catch (err) {
        res.writeHead(302, { 'Location': '/admin/login?error=invalid' });
        res.end();
      }
    });
    return;
  }

  // Logout
  if (pathname === '/admin/logout') {
    res.writeHead(302, {
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'Location': '/admin/login'
    });
    res.end();
    return;
  }

  // Admin panel UI (all /admin/plugins* except /admin/plugins/api/*)
  if (pathname.startsWith('/admin/plugins') && !pathname.startsWith('/admin/plugins/api')) {
    const session = checkAdminAuth(req);
    if (!session) {
      const returnUrl = encodeURIComponent(req.url);
      res.writeHead(302, { 'Location': `/admin/login?return_to=${returnUrl}` });
      res.end();
      return;
    }

    // Serve admin.html for any /admin/plugins* path
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

  // Redirect /admin/badges to /admin/plugins
  if (pathname === '/admin/badges') {
    res.writeHead(302, { 'Location': '/admin/plugins' });
    res.end();
    return;
  }

  // 404 for unmatched routes
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[admin-panel] listening on port ${PORT}`);
});
