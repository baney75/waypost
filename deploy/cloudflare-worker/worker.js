// Optional front door: serve Waypost on a Cloudflare custom domain while the server sits behind
// another HTTPS endpoint (for example Tailscale Funnel). It forwards requests to the one fixed
// ORIGIN, including Authorization, and adds no caching, logging or state.
export default {
  async fetch(request, env) {
    const origin = new URL(env.ORIGIN);
    const incoming = new URL(request.url);
    // Set path and query on a copy of ORIGIN; never resolve the path as a URL, or "//host" would pick the upstream.
    const target = new URL(origin.href);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    if (target.origin !== origin.origin) return new Response('Bad request', {status:400});
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    const init = {method:request.method, headers, redirect:'manual'};
    if (!['GET','HEAD'].includes(request.method)) init.body = request.body;
    const response = await fetch(target, init);
    const out = new Headers(response.headers);
    out.delete('set-cookie');
    return new Response(response.body, {status:response.status, statusText:response.statusText, headers:out});
  },
};
