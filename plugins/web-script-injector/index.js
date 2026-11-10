const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://app-proxy:8080';
const SCRIPT_VERSION = process.env.SCRIPT_VERSION || '2.4.0';

const server = http.createServer(async (req, res) => {
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
          const scriptTag = `<script src="/custom-badges/encora-badges.js?v=${SCRIPT_VERSION}" defer></script>`;
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
      console.error('[plugin-web-script-injector] Upstream app-proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: Upstream app-proxy unavailable');
    });

    req.pipe(clientReq);
  } catch (err) {
    console.error('[plugin-web-script-injector] Proxy fatal error:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[plugin-web-script-injector] Listening on 0.0.0.0:${PORT}, upstream: ${UPSTREAM_URL}`);
});
