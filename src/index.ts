interface Env {
  ALLOWED_HOSTS?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

interface AllowedHosts {
  exact: Set<string>;
  suffix: string[];
}

function parseAllowedHosts(value: string | undefined): AllowedHosts | null {
  if (!value) return null;
  const exact = new Set<string>();
  const suffix: string[] = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.')) suffix.push(entry.slice(1));
    else exact.add(entry);
  }
  if (exact.size === 0 && suffix.length === 0) return null;
  return { exact, suffix };
}

function isHostAllowed(host: string, allowed: AllowedHosts): boolean {
  const lower = host.toLowerCase();
  if (allowed.exact.has(lower)) return true;
  return allowed.suffix.some((s) => lower.endsWith(s) && lower.length > s.length);
}

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
]);

function resolveTarget(request: Request): string | null {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, '');

  if (path) {
    if (/^https?:\/\//i.test(path)) return path + url.search;
    const match = path.match(/^(https?:)\/?(.+)$/i);
    if (match) return `${match[1]}//${match[2]}${url.search}`;
    return null;
  }

  return url.searchParams.get('url');
}

function filterHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') continue;
    if (!HOP_BY_HOP.has(lower)) filtered.set(key, value);
  }
  for (const cookie of headers.getSetCookie()) {
    filtered.append('set-cookie', cookie);
  }
  return filtered;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const target = resolveTarget(request);
    if (!target) {
      return new Response(
        'Usage: /<target-url> or ?url=<target-url>\nExample: /https://api.example.com/data',
        { status: 400, headers: { 'content-type': 'text/plain', ...CORS_HEADERS } },
      );
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response(`Invalid target URL: ${target}`, {
        status: 400,
        headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
      });
    }

    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return new Response('Only http(s) targets are supported', {
        status: 400,
        headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
      });
    }

    const allowed = parseAllowedHosts(env.ALLOWED_HOSTS);
    if (allowed && !isHostAllowed(targetUrl.hostname, allowed)) {
      return new Response(`Host not allowed: ${targetUrl.hostname}`, {
        status: 403,
        headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
      });
    }

    const proxiedRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: filterHeaders(request.headers),
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    });

    let upstream: Response;
    try {
      upstream = await fetch(proxiedRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Upstream fetch failed: ${message}`, {
        status: 502,
        headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
      });
    }

    const responseHeaders = filterHeaders(upstream.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(key, value);
    }
    const exposed = [...upstream.headers.keys()]
      .filter((k) => {
        const lower = k.toLowerCase();
        return !HOP_BY_HOP.has(lower) && lower !== 'set-cookie';
      })
      .join(', ');
    if (exposed) responseHeaders.set('Access-Control-Expose-Headers', exposed);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
