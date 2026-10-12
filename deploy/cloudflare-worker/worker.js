// Optional front door: serve Waypost on a Cloudflare custom domain while the server sits behind
// another HTTPS endpoint (for example Tailscale Funnel). It forwards requests unchanged, including
// Authorization, and adds no caching, logging or state. ORIGIN is the upstream https:// origin.
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, env.ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    const init = {method:request.method, headers, redirect:'manual'};
    if (!['GET','HEAD'].includes(request.method)) init.body = request.body;
    const response = await fetch(target, init);
    return new Response(response.body, {status:response.status, statusText:response.statusText, headers:response.headers});
  },
};
