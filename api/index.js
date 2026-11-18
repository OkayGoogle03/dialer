// Vercel Function entry. Plain JavaScript on purpose: it only loads the NestJS app that `pnpm --filter @dialer/api build`
// compiled into services/api/dist. All /api/* requests are rewritten here by vercel.json.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getHandler } = require('../services/api/dist/vercel');

module.exports = async (req, res) => {
  try {
    const handler = await getHandler();
    return handler(req, res);
  } catch (e) {
    console.error('API failed to start:', e && e.message ? e.message : e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { status: 503, code: 'API_UNAVAILABLE', message: 'The API failed to start. Check the function logs and the environment variables.' } }));
  }
};
