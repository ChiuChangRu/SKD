// 專案排程 API（Cloudflare Worker + KV）
// 設計重點：
//  - 與 MyWiki 完全獨立：自己的 PM_PIN（Secret）、自己的 KV，不共用任何登入或資料
//  - 所有 /api/* 都要帶 x-pin；PIN 比對用固定時間比對；連續輸錯會暫時鎖定（依來源 IP）
//  - CORS 只放行 ALLOWED_ORIGIN
//  - KV key：case:<id> ＝ {title,body,n}；tpl ＝ {b64}（公司 Excel 範本，只存在這裡，不進 GitHub）
const MAX_FAIL = 8, LOCK_SEC = 600;

const cors = (env, req) => {
  const o = req.headers.get('origin') || '';
  const ok = o && (o === env.ALLOWED_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  return {
    'access-control-allow-origin': ok ? o : env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-pin',
    'access-control-max-age': '86400',
    'vary': 'origin',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
};
const json = (env, req, status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors(env, req), 'content-type': 'application/json; charset=utf-8' } });

function safeEq(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

async function auth(env, req) {
  if (!env.PM_PIN) return { ok: false, status: 503, error: '伺服器尚未設定 PM_PIN' };
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const fk = 'fail:' + ip;
  const f = parseInt((await env.PM_KV.get(fk)) || '0', 10);
  if (f >= MAX_FAIL) return { ok: false, status: 429, error: '輸錯次數過多，請 10 分鐘後再試' };
  const nz = (v) => String(v || '').normalize('NFKC').trim(); // 全形數字／前後空白視為相同
  let pin = ''; try { pin = nz(decodeURIComponent(req.headers.get('x-pin') || '')); } catch { pin = nz(req.headers.get('x-pin')); }
  if (pin && safeEq(pin, nz(env.PM_PIN))) { if (f) await env.PM_KV.delete(fk); return { ok: true }; }
  if (pin) await env.PM_KV.put(fk, String(f + 1), { expirationTtl: LOCK_SEC });
  return { ok: false, status: 401, error: 'PIN 錯誤' };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
    if (!url.pathname.startsWith('/api/')) return new Response('pm-schedule OK', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const a = await auth(env, req);
    if (!a.ok) return json(env, req, a.status, { error: a.error });
    const p = url.pathname.replace(/^\/api/, ''), m = req.method;
    try {
      if (p === '/ping') return json(env, req, 200, { ok: true });
      if (p === '/folders') return json(env, req, 200, [{ id: 1, name: 'PM工具' }]);
      if (p === '/entries' && m === 'GET') {
        const out = []; let cursor;
        do {
          const l = await env.PM_KV.list({ prefix: 'case:', cursor });
          for (const k of l.keys) { const meta = k.metadata || {}; out.push({ id: k.name.slice(5), title: meta.title || '', n: meta.n || 0 }); }
          cursor = l.list_complete ? undefined : l.cursor;
        } while (cursor);
        out.sort((x, y) => y.n - x.n);
        return json(env, req, 200, out);
      }
      if (p === '/entries' && m === 'POST') {
        const j = await req.json(); const n = Date.now(); const id = 'c' + n;
        await env.PM_KV.put('case:' + id, JSON.stringify({ title: j.title, body: j.body, n }), { metadata: { title: j.title || '', n } });
        return json(env, req, 200, { id });
      }
      const mm = p.match(/^\/entries\/([A-Za-z0-9_-]{1,64})$/);
      if (mm) {
        const key = 'case:' + mm[1];
        if (m === 'GET') {
          const v = await env.PM_KV.get(key, 'json'); if (!v) return json(env, req, 404, { error: '找不到資料' });
          return json(env, req, 200, { id: mm[1], title: v.title, body: v.body });
        }
        if (m === 'PUT') {
          const j = await req.json(); const ex = await env.PM_KV.get(key, 'json');
          const v = ex ? { ...ex, body: j.body, ...(j.title ? { title: j.title } : {}) } : { title: j.title || mm[1], body: j.body, n: j.n || 0 };
          await env.PM_KV.put(key, JSON.stringify(v), { metadata: { title: v.title || '', n: v.n || 0 } });
          return json(env, req, 200, { ok: true });
        }
        if (m === 'DELETE') { await env.PM_KV.delete(key); return json(env, req, 200, { ok: true }); }
      }
      if (p === '/tpl') {
        if (m === 'GET') { const v = await env.PM_KV.get('tpl', 'json'); if (!v) return json(env, req, 404, { error: '還沒有公司 Excel 範本' }); return json(env, req, 200, v); }
        if (m === 'PUT') { const j = await req.json(); if (!j.b64) return json(env, req, 400, { error: '缺少 b64' }); await env.PM_KV.put('tpl', JSON.stringify({ b64: j.b64 })); return json(env, req, 200, { ok: true }); }
      }
      return json(env, req, 404, { error: '不支援的路徑 ' + p });
    } catch (e) {
      return json(env, req, 500, { error: String((e && e.message) || e) });
    }
  },
};
