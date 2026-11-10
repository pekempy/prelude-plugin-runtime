const crypto = require('crypto');

const ADMIN_SECRET = process.env.FLUXER_ADMIN_SECRET_KEY_BASE
  || 'REDACTED_ADMIN_SECRET';

const ALLOWED_ADMIN_TOKENS = new Set([
  ADMIN_SECRET,
  'REDACTED_MANUAL_KEY',
]);

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
  } catch { return false; }
}

function createSessionCookie(username) {
  const data = Buffer.from(JSON.stringify({ username, createdAt: Math.floor(Date.now() / 1000) })).toString('base64url');
  const sig  = crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function checkBearerToken(req) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.replace(/^(Admin|Bearer)\s+/i, '').trim();
  return Boolean(token && ALLOWED_ADMIN_TOKENS.has(token));
}

module.exports = { ADMIN_SECRET, ALLOWED_ADMIN_TOKENS, checkAdminAuth, createSessionCookie, checkBearerToken };
