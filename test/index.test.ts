import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import worker from '../src/index.ts';

const realFetch = globalThis.fetch;

type FetchImpl = (input: Request) => Promise<Response>;

function mockUpstream(impl: FetchImpl) {
  const fn = mock(impl);
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(req: Request, env: { ALLOWED_HOSTS?: string } = {}) {
  return worker.fetch(req, env);
}

describe('OPTIONS preflight', () => {
  it('returns 204 with CORS headers', async () => {
    const res = await call(
      new Request('https://proxy.test/https://api.example.com', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')).toBe('*');
  });
});

function firstCallArg(fn: ReturnType<typeof mockUpstream>): Request {
  const call = fn.mock.calls[0];
  if (!call) throw new Error('upstream fetch was not called');
  return call[0];
}

describe('target resolution', () => {
  it('rejects requests with no target', async () => {
    const res = await call(new Request('https://proxy.test/'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Usage');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects invalid target URLs', async () => {
    const res = await call(new Request('https://proxy.test/not-a-url'));
    expect(res.status).toBe(400);
  });

  it('rejects non-http(s) protocols', async () => {
    const res = await call(new Request('https://proxy.test/?url=ftp://example.com'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('http(s)');
  });

  it('accepts path-style target', async () => {
    const upstream = mockUpstream(async () => new Response('ok', { status: 200 }));
    const res = await call(new Request('https://proxy.test/https://api.example.com/data'));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(firstCallArg(upstream).url).toBe('https://api.example.com/data');
  });

  it('accepts query-style target', async () => {
    const upstream = mockUpstream(async () => new Response('ok', { status: 200 }));
    await call(new Request('https://proxy.test/?url=https://api.example.com/data'));
    expect(firstCallArg(upstream).url).toBe('https://api.example.com/data');
  });

  it('repairs single-slash path-style targets (https:/host)', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    await call(new Request('https://proxy.test/https:/api.example.com/data'));
    expect(firstCallArg(upstream).url).toBe('https://api.example.com/data');
  });

  it('forwards query string from proxy to target', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    await call(new Request('https://proxy.test/https://api.example.com/x?a=1&b=2'));
    expect(firstCallArg(upstream).url).toBe('https://api.example.com/x?a=1&b=2');
  });

  it('does not let ?url= hijack a path-style request', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    await call(new Request('https://proxy.test/https://api.example.com/x?url=https://evil.com'));
    expect(firstCallArg(upstream).url).toBe('https://api.example.com/x?url=https://evil.com');
  });

  it('rejects non-URL paths instead of falling back to ?url=', async () => {
    const res = await call(new Request('https://proxy.test/garbage?url=https://evil.com'));
    expect(res.status).toBe(400);
  });
});

describe('request forwarding', () => {
  it('forwards method and body for POST', async () => {
    const upstream = mockUpstream(async (req) => {
      const text = await req.text();
      return new Response(`echo:${text}`, { status: 201 });
    });
    const res = await call(
      new Request('https://proxy.test/https://api.example.com/post', {
        method: 'POST',
        body: 'hello',
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('echo:hello');
    expect(firstCallArg(upstream).method).toBe('POST');
  });

  it('omits body for GET', async () => {
    const upstream = mockUpstream(async (req) => {
      expect(req.body).toBeNull();
      return new Response('ok');
    });
    await call(new Request('https://proxy.test/https://api.example.com'));
    expect(upstream).toHaveBeenCalled();
  });

  it('strips hop-by-hop and CF headers', async () => {
    const upstream = mockUpstream(async (req) => {
      expect(req.headers.get('cf-connecting-ip')).toBeNull();
      expect(req.headers.get('x-forwarded-for')).toBeNull();
      expect(req.headers.get('connection')).toBeNull();
      expect(req.headers.get('x-keep-this')).toBe('yes');
      return new Response('ok');
    });
    await call(
      new Request('https://proxy.test/https://api.example.com', {
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          connection: 'close',
          'x-keep-this': 'yes',
        },
      }),
    );
    expect(upstream).toHaveBeenCalled();
  });
});

describe('response handling', () => {
  it('adds CORS headers to upstream response', async () => {
    mockUpstream(
      async () =>
        new Response('body', {
          status: 200,
          headers: { 'content-type': 'text/plain', 'x-custom': 'value' },
        }),
    );
    const res = await call(new Request('https://proxy.test/https://api.example.com'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-custom')).toBe('value');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-custom');
  });

  it('preserves upstream status', async () => {
    mockUpstream(async () => new Response('not found', { status: 404 }));
    const res = await call(new Request('https://proxy.test/https://api.example.com'));
    expect(res.status).toBe(404);
  });

  it('preserves multiple Set-Cookie headers without collapsing', async () => {
    mockUpstream(async () => {
      const h = new Headers();
      h.append('set-cookie', 'a=1; Path=/');
      h.append('set-cookie', 'b=2; Path=/');
      return new Response('ok', { status: 200, headers: h });
    });
    const res = await call(new Request('https://proxy.test/https://api.example.com'));
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('omits set-cookie from Access-Control-Expose-Headers', async () => {
    mockUpstream(async () => {
      const h = new Headers();
      h.append('set-cookie', 'a=1');
      h.set('x-custom', 'value');
      return new Response('ok', { status: 200, headers: h });
    });
    const res = await call(new Request('https://proxy.test/https://api.example.com'));
    const exposed = res.headers.get('access-control-expose-headers') ?? '';
    expect(exposed).toContain('x-custom');
    expect(exposed.toLowerCase()).not.toContain('set-cookie');
  });

  it('returns 502 on upstream failure', async () => {
    mockUpstream(async () => {
      throw new Error('network down');
    });
    const res = await call(new Request('https://proxy.test/https://api.example.com'));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('network down');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('host allowlist', () => {
  it('allows any host when ALLOWED_HOSTS is unset', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    const res = await call(new Request('https://proxy.test/https://anywhere.example/'));
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('allows any host when ALLOWED_HOSTS is empty / whitespace', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    const res = await call(new Request('https://proxy.test/https://anywhere.example/'), {
      ALLOWED_HOSTS: '  ,  ',
    });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('allows exact-match hosts', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    const res = await call(new Request('https://proxy.test/https://api.example.com/data'), {
      ALLOWED_HOSTS: 'api.example.com, other.test',
    });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('rejects hosts not in the allowlist with 403', async () => {
    const upstream = mockUpstream(async () => new Response('should-not-fetch'));
    const res = await call(new Request('https://proxy.test/https://evil.com/'), {
      ALLOWED_HOSTS: 'api.example.com',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('evil.com');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('matches subdomains for *.example.com but not the apex', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));

    const sub = await call(new Request('https://proxy.test/https://a.example.com/'), {
      ALLOWED_HOSTS: '*.example.com',
    });
    expect(sub.status).toBe(200);

    const deeper = await call(new Request('https://proxy.test/https://x.y.example.com/'), {
      ALLOWED_HOSTS: '*.example.com',
    });
    expect(deeper.status).toBe(200);

    const apex = await call(new Request('https://proxy.test/https://example.com/'), {
      ALLOWED_HOSTS: '*.example.com',
    });
    expect(apex.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('does not let lookalike hosts bypass the suffix match', async () => {
    const res = await call(new Request('https://proxy.test/https://notexample.com/'), {
      ALLOWED_HOSTS: '*.example.com',
    });
    expect(res.status).toBe(403);
  });

  it('matches case-insensitively', async () => {
    const upstream = mockUpstream(async () => new Response('ok'));
    const res = await call(new Request('https://proxy.test/https://API.Example.COM/'), {
      ALLOWED_HOSTS: 'api.example.com',
    });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
