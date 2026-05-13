import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { Subprocess } from 'bun';

const PROXY_PORT = 18787;
const UPSTREAM_PORT = 18788;
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
const UPSTREAM_BASE = `http://localhost:${UPSTREAM_PORT}`;

const upstreamRequests: { method: string; pathname: string; headers: Record<string, string> }[] =
  [];

let upstream: ReturnType<typeof Bun.serve> | null = null;
let wrangler: Subprocess | null = null;

async function waitForProxy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(PROXY_BASE, { method: 'OPTIONS' });
      if (res.status === 204) {
        await res.body?.cancel();
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `wrangler dev did not become ready in ${timeoutMs}ms (last error: ${String(lastError)})`,
  );
}

beforeAll(async () => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      upstreamRequests.push({
        method: req.method,
        pathname: u.pathname,
        headers: Object.fromEntries(req.headers),
      });

      if (u.pathname === '/status/404') {
        return new Response('not found', { status: 404 });
      }
      if (u.pathname === '/set-cookies') {
        const h = new Headers({ 'content-type': 'text/plain' });
        h.append('set-cookie', 'a=1; Path=/');
        h.append('set-cookie', 'b=2; Path=/');
        return new Response('ok', { headers: h });
      }
      if (u.pathname === '/echo') {
        const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
        return new Response(`echo:${req.method}:${body}`, {
          headers: { 'content-type': 'text/plain', 'x-upstream': 'test' },
        });
      }
      return new Response('hello', { headers: { 'content-type': 'text/plain' } });
    },
  });

  const debug = process.env.DEBUG_E2E === '1';
  wrangler = Bun.spawn(
    [
      'bunx',
      'wrangler',
      'dev',
      '--port',
      String(PROXY_PORT),
      '--ip',
      '127.0.0.1',
      '--var',
      'ALLOWED_HOSTS:localhost',
      '--log-level',
      debug ? 'info' : 'error',
    ],
    {
      stdout: debug ? 'inherit' : 'ignore',
      stderr: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );

  await waitForProxy(90_000);
}, 120_000);

afterAll(async () => {
  if (wrangler) {
    wrangler.kill();
    await wrangler.exited.catch(() => {});
  }
  if (upstream) {
    await upstream.stop(true);
  }
});

describe('e2e: proxy against wrangler dev', () => {
  it('answers OPTIONS preflight with 204 + CORS', async () => {
    const res = await fetch(PROXY_BASE, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('proxies a GET, returns body and CORS headers', async () => {
    const before = upstreamRequests.length;
    const res = await fetch(`${PROXY_BASE}/${UPSTREAM_BASE}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(upstreamRequests.length).toBe(before + 1);
    expect(upstreamRequests.at(-1)?.pathname).toBe('/hello');
  });

  it('forwards method and body for POST', async () => {
    const res = await fetch(`${PROXY_BASE}/${UPSTREAM_BASE}/echo`, {
      method: 'POST',
      body: 'payload',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo:POST:payload');
    expect(res.headers.get('x-upstream')).toBe('test');
  });

  it('preserves multiple Set-Cookie headers without collapsing', async () => {
    const res = await fetch(`${PROXY_BASE}/${UPSTREAM_BASE}/set-cookies`);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('strips hop-by-hop / CF headers before forwarding', async () => {
    const before = upstreamRequests.length;
    await fetch(`${PROXY_BASE}/${UPSTREAM_BASE}/echo`, {
      headers: {
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '1.2.3.4',
        'x-keep-this': 'yes',
      },
    });
    const seen = upstreamRequests.at(-1);
    expect(upstreamRequests.length).toBe(before + 1);
    expect(seen?.headers['cf-connecting-ip']).toBeUndefined();
    expect(seen?.headers['x-forwarded-for']).toBeUndefined();
    expect(seen?.headers['x-keep-this']).toBe('yes');
  });

  it('blocks non-allowlisted hosts with 403 (does not hit upstream)', async () => {
    const before = upstreamRequests.length;
    const res = await fetch(`${PROXY_BASE}/http://evil.example.test/`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('evil.example.test');
    expect(upstreamRequests.length).toBe(before);
  });
});
