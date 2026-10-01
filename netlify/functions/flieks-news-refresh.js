/**
 * flieks-news-refresh — reads the industry news feeds for the Lab.
 * Scheduled in netlify.toml every three hours. Scheduled functions can't be
 * called from the web, so this takes no input. See netlify/lib/news-core.js.
 */
const ops = require('../lib/ops-core');
const news = require('../lib/news-core');

exports.handler = async () => {
  try {
    const { items, meta } = await news.refresh(ops);
    console.log('[news-refresh]', Object.keys(items).length, 'stories', JSON.stringify(meta.sources));
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('[news-refresh]', e);
    return { statusCode: 500, body: 'failed' };
  }
};
