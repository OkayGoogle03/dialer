// Vercel Function entry. Plain JavaScript on purpose: it only loads the NestJS app that `pnpm --filter @dialer/api build`
// compiled into services/api/dist. All /api/* requests are rewritten here by vercel.json.
/* eslint-disable @typescript-eslint/no-require-imports */
const { getHandler } = require('../services/api/dist/vercel');

module.exports = async (req, res) => {
  try {
    const handler = await getHandler();
    return handler(req, res);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    console.error('API failed to start:', msg || e);
    // Configuration errors only ever name the missing/invalid settings (never values), so they are safe to show.
    const detail = msg.startsWith('Invalid configuration') ? ` ${msg.replace(/:\s*\n\s*-\s*/, ': ').replace(/\s*\n\s*-\s*/g, '; ')}` : '';
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { status: 503, code: 'API_UNAVAILABLE', message: `The API failed to start.${detail || ' Check the function logs.'}` } }));
  }
};
