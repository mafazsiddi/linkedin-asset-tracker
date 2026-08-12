const { query } = require('../../../lib/db');
const { json } = require('../../../lib/util');

// Exchanges the OAuth code for tokens and stores them. Once this succeeds, flip
// LINKEDIN_MODE=live and the daily cron will call the real LinkedIn API.
module.exports = async function handler(req, res) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  const { code, error, error_description: errorDescription } = req.query;

  if (error) return json(res, 400, { error, errorDescription });
  if (!clientId || !clientSecret || !redirectUri) {
    return json(res, 501, { error: 'LinkedIn app not configured yet.' });
  }
  if (!code) return json(res, 400, { error: 'Missing code' });

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });

  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return json(res, 400, tokenData);

  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 0) * 1000);
  await query('delete from linkedin_tokens');
  await query(
    'insert into linkedin_tokens (access_token, refresh_token, expires_at) values ($1,$2,$3)',
    [tokenData.access_token, tokenData.refresh_token || null, expiresAt]
  );
  return json(res, 200, { ok: true, message: 'LinkedIn account connected. Set LINKEDIN_MODE=live to start using it.' });
};
