// Front door: serve Waypost on workers.dev (free, no domain) or a custom domain. With a Workers VPC binding
// (ORIGIN_VPC) it reaches Waypost through a Cloudflare tunnel that has no public hostname, so the
// server is reachable only through this Worker. waypost setup cloudflare uploads this file as is. Without one it forwards to the one fixed HTTPS
// ORIGIN (for example Tailscale Funnel). It passes Authorization and adds no caching, logging or state.
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    // Through VPC the tunnel picks the server; keep the public host so Waypost's Host check passes.
    const origin = env.ORIGIN_VPC ? new URL(`http://${incoming.host}`) : new URL(env.ORIGIN);
    // Set path and query on a copy of the origin; never resolve the path as a URL, or "//host" would pick the upstream.
    const target = new URL(origin.href);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    if (target.origin !== origin.origin) return new Response('Bad request', {status:400});
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    const init = {method:request.method, headers, redirect:'manual'};
    if (!['GET','HEAD'].includes(request.method)) init.body = request.body;
    let response;
    try {
      response = env.ORIGIN_VPC ? await env.ORIGIN_VPC.fetch(target, init) : await fetch(target, init);
    } catch {
      // An offline server or tunnel makes the fetch throw. Uncaught, Cloudflare shows a bare "error code: 1101".
      return new Response('Waypost server unreachable: this front door is up, but the Waypost server behind it is not answering.\n', {status:502, headers:{'content-type':'text/plain; charset=utf-8', 'cache-control':'no-store', 'retry-after':'60'}});
    }
    const out = new Headers(response.headers);
    out.delete('set-cookie');
    return new Response(response.body, {status:response.status, statusText:response.statusText, headers:out});
  },
};
