// In-memory stand-ins for KV, R2 and Graph. They model only what the code reads.

/** KV: get(k, "json"), put(k, v, {expirationTtl, metadata}), delete, list({prefix, cursor, limit}). */
export function kvMock(init = {}) {
  const m = new Map();
  for (const [k, v] of Object.entries(init)) m.set(k, { v: typeof v === "string" ? v : JSON.stringify(v), o: {} });
  return {
    m,
    get: async (k, type) => { if (!m.has(k)) return null; const v = m.get(k).v; return type === "json" ? JSON.parse(v) : v; },
    put: async (k, v, o) => { m.set(k, { v: String(v), o: o || {} }); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "", cursor, limit = 1000 } = {}) => {
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const done = start + limit >= all.length;
      return { keys: page.map((k) => ({ name: k, metadata: (m.get(k).o || {}).metadata })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    }
  };
}

/** R2: get (with etag), head, put (onlyIf etagMatches / uploadedBefore), delete. */
export function r2Mock() {
  const m = new Map();
  let n = 0;
  const obj = (k) => {
    const e = m.get(k);
    const bytes = typeof e.v === "string" ? new TextEncoder().encode(e.v) : new Uint8Array(e.v);
    return { etag: e.etag, size: bytes.byteLength, httpMetadata: e.http || {}, body: bytes, text: async () => new TextDecoder().decode(bytes) };
  };
  return {
    m,
    get: async (k) => (m.has(k) ? obj(k) : null),
    head: async (k) => (m.has(k) ? { etag: m.get(k).etag } : null),
    put: async (k, v, o = {}) => {
      if (o.onlyIf) {
        if (o.onlyIf.etagMatches && (!m.has(k) || m.get(k).etag !== o.onlyIf.etagMatches)) return null;
        if (o.onlyIf.uploadedBefore && m.has(k)) return null;
      }
      m.set(k, { v, etag: "e" + (++n), http: o.httpMetadata || {} });
      return { etag: "e" + n };
    },
    delete: async (k) => { m.delete(k); },
    json: (k) => (m.has(k) ? JSON.parse(typeof m.get(k).v === "string" ? m.get(k).v : new TextDecoder().decode(m.get(k).v)) : null)
  };
}

/** A fetch stub: route(url, init) -> JSON-able object (or a Response). Records every call. */
export function fetchMock(route) {
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    const form = init && init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    calls.push({ url: u, method: (init && init.method) || "GET", form });
    const r = await route(u, init || {}, form);
    if (r instanceof Response) return r;
    return { ok: true, status: 200, headers: new Headers(), json: async () => r, text: async () => JSON.stringify(r) };
  };
  f.calls = calls;
  return f;
}

/** Capture console.log lines while fn runs. */
export async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try { await fn(); } finally { console.log = orig; }
  return lines;
}
