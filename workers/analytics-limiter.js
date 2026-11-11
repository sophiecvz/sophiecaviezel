const headers = { 'cache-control': 'no-store' };

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/check') {
      return new Response(null, { status: 404, headers });
    }

    // The only caller is the Pages Function through a private Service Binding.
    const key = request.headers.get('x-analytics-rate-key');
    if (!key || key.length > 64) return new Response(null, { status: 400, headers });

    if (typeof env.EVENT_RATE_LIMIT?.limit !== 'function') {
      console.error('[analytics-limiter:error] missing_rate_limit_binding');
      return new Response(null, { status: 503, headers });
    }

    try {
      const { success } = await env.EVENT_RATE_LIMIT.limit({ key: `events:${key}` });
      return new Response(null, { status: success ? 204 : 429, headers });
    } catch (error) {
      console.error('[analytics-limiter:error] rate_limit_failed', error);
      return new Response(null, { status: 503, headers });
    }
  },
};
