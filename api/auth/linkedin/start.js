const { json } = require('../../../lib/util');

// Kicks off the LinkedIn OAuth flow. Inert (returns 501) until LINKEDIN_CLIENT_ID and
// LINKEDIN_REDIRECT_URI are set, which only happens once the Marketing Developer Platform app
// is approved — see README.
module.exports = async function handler(req, res) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return json(res, 501, {
      error: 'LinkedIn app not configured yet. Set LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI once the Marketing Developer Platform app is approved.'
    });
  }
  const scope = encodeURIComponent('r_ads r_ads_reporting rw_ads');
  const url =
    `https://www.linkedin.com/oauth/v2/authorization?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}`;
  res.writeHead(302, { Location: url });
  res.end();
};
