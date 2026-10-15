// Firefly · servidor puente (SPIDI, Shopify y Mercado Libre)
// Guarda las credenciales de las plataformas fuera de la app y expone solo lo necesario:
//   GET  /health[?check=1]        estado del puente y de cada integración
//   POST /sessions                SPIDI: crea un cobro (link + QR)            — requiere x-bridge-key
//   GET  /sessions/:id            SPIDI: estado de un cobro                   — requiere x-bridge-key
//   POST /webhook/spidi           SPIDI: avisos (se re-verifican contra la API)
//   GET  /shopify/orders?since=   Shopify: pedidos recientes normalizados     — requiere x-bridge-key
//   POST /shopify/inventory       Shopify: fija el stock por SKU              — requiere x-bridge-key
//   GET  /ml/orders?since=        Mercado Libre: ventas recientes             — requiere x-bridge-key
//   POST /ml/stock                Mercado Libre: fija available_quantity      — requiere x-bridge-key
// Cada integración es opcional: solo se activa si sus variables de entorno existen.
// Sin dependencias: Node 18+ (fetch nativo).
'use strict';
const http = require('http');
const crypto = require('crypto');

const ENV = (process.env.SPIDI_ENV || 'sandbox').toLowerCase().startsWith('prod') ? 'production' : 'sandbox';
const BASE = process.env.SPIDI_BASE_URL || (ENV === 'production' ? 'https://api.spidipagos.com' : 'https://sandbox.api.spidipagos.com');
const SHORT_NAME = process.env.SPIDI_SHORT_NAME || '';
const PASSWORD = process.env.SPIDI_PASSWORD || '';
const AGREEMENT_ID = process.env.SPIDI_AGREEMENT_ID || null;
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const PORT = +process.env.PORT || 8787;
const MAX_USD = +process.env.MAX_AMOUNT_USD || 5000;

// Shopify (Admin API · app personalizada con permisos read_orders, read_products, write_inventory, read_locations)
const SHOP = (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''); // tutienda.myshopify.com
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';          // token fijo (apps antiguas creadas en el admin)
const SHOP_CID = process.env.SHOPIFY_CLIENT_ID || '', SHOP_SECRET = process.env.SHOPIFY_CLIENT_SECRET || ''; // apps del Dev Dashboard
const SHOP_VER = process.env.SHOPIFY_API_VERSION || '2026-10';
let shopTok = null, shopExp = 0;
let SHOP_LOC = process.env.SHOPIFY_LOCATION_ID || '';
// Mercado Libre (app en developers.mercadolibre.com.ve con OAuth)
const ML_ID = process.env.ML_CLIENT_ID || '', ML_SECRET = process.env.ML_CLIENT_SECRET || '';
let ML_REFRESH = process.env.ML_REFRESH_TOKEN || '';
let mlTok = null, mlExp = 0, mlSeller = process.env.ML_SELLER_ID || '';

let token = null, tokenExp = 0;
const cache = new Map(); // session_id -> { data, ts }

function log(...a) { console.log(new Date().toISOString(), ...a); }
function jwtExp(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000; } catch { return Date.now() + 5 * 60e3; } }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

async function login(force) {
  if (!force && token && Date.now() < tokenExp - 60e3) return token;
  if (!SHORT_NAME || !PASSWORD) throw new Error('Faltan SPIDI_SHORT_NAME o SPIDI_PASSWORD en el puente');
  const r = await fetch(BASE + '/api/spidipagos/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ short_name: SHORT_NAME, password: PASSWORD }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('Login SPIDI falló (' + r.status + '): ' + (j.message || j.error || 'sin token'));
  token = j.token; tokenExp = jwtExp(token); return token;
}
async function spidi(path, opt = {}, retry = true) {
  const t = await login();
  const r = await fetch(BASE + path, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(opt.headers || {}) } });
  if (r.status === 401 && retry) { await login(true); return spidi(path, opt, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) { const e = new Error(j.message || j.error || ('SPIDI respondió ' + r.status)); e.status = r.status; e.body = j; throw e; }
  return j;
}
async function status(id) {
  const c = cache.get(id);
  if (c && (c.data.status === 'paid' || Date.now() - c.ts < 3000)) return c.data;
  const j = await spidi('/api/v1/ext/payment-sessions/status/' + encodeURIComponent(id), { method: 'GET' });
  const d = j.data || {}; cache.set(id, { data: d, ts: Date.now() }); return d;
}

/* ---------- Shopify ---------- */
const shopOn = () => !!(SHOP && (SHOP_TOKEN || (SHOP_CID && SHOP_SECRET)));
async function shopToken(force) {
  if (!shopOn()) { const e = new Error('Shopify no está configurado en el puente (SHOPIFY_STORE y SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)'); e.status = 400; throw e; }
  if (SHOP_TOKEN) return SHOP_TOKEN;
  if (!force && shopTok && Date.now() < shopExp - 5 * 60e3) return shopTok;
  // Apps del Dev Dashboard instaladas en tu propia tienda: client credentials grant (el token dura 24 h y se renueva solo)
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOP_CID, client_secret: SHOP_SECRET }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error('Shopify: no se pudo obtener el token (' + (j.error_description || j.error || r.status) + '). ¿La app está instalada en la tienda?'); e.status = 502; throw e; }
  shopTok = j.access_token; shopExp = Date.now() + (j.expires_in || 86399) * 1000; return shopTok;
}
async function shopGQL(query, variables, retry = true) {
  const t = await shopToken();
  const r = await fetch(`https://${SHOP}/admin/api/${SHOP_VER}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': t }, body: JSON.stringify({ query, variables }) });
  if (r.status === 401 && retry && !SHOP_TOKEN) { await shopToken(true); return shopGQL(query, variables, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) { const e = new Error('Shopify: ' + (j.errors ? JSON.stringify(j.errors).slice(0, 300) : r.status)); e.status = r.status === 401 ? 401 : 502; throw e; }
  return j.data;
}
const ORDERS_Q = `query($q: String) { orders(first: 100, sortKey: CREATED_AT, reverse: true, query: $q) { edges { node {
  id name createdAt note cancelledAt displayFinancialStatus currencyCode email phone paymentGatewayNames
  totalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }
  shippingAddress { firstName lastName name phone address1 address2 city province }
  customer { firstName lastName phone }
  lineItems(first: 50) { edges { node { sku title quantity originalUnitPriceSet { shopMoney { amount } } } } } } } } }`;
async function shopOrders(since) {
  const q = since ? 'created_at:>=' + new Date(+since || since).toISOString() : null;
  const d = await shopGQL(ORDERS_Q, { q });
  return d.orders.edges.map(({ node: o }) => {
    const sa = o.shippingAddress || {}, cu = o.customer || {};
    return {
      origen: 'SHOPIFY', id: String(o.id).split('/').pop(), numero: o.name, fecha: Date.parse(o.createdAt),
      cliente: { nombre: [sa.firstName || cu.firstName, sa.lastName || cu.lastName].filter(Boolean).join(' ') || sa.name || o.email || 'Cliente Shopify', telefono: sa.phone || cu.phone || o.phone || '', email: o.email || '', direccion: [sa.address1, sa.address2, sa.city, sa.province].filter(Boolean).join(', ') },
      items: o.lineItems.edges.map(({ node: li }) => ({ sku: li.sku || '', titulo: li.title, cantidad: li.quantity, precio: +(li.originalUnitPriceSet?.shopMoney?.amount || 0) })),
      moneda: o.currencyCode, total: +(o.totalPriceSet?.shopMoney?.amount || 0), envio: +(o.totalShippingPriceSet?.shopMoney?.amount || 0),
      pagado: ['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus), estadoPago: o.displayFinancialStatus,
      cancelado: !!o.cancelledAt, nota: o.note || '', pasarela: (o.paymentGatewayNames || []).join(', ')
    };
  });
}
async function shopLocation() {
  if (SHOP_LOC) return SHOP_LOC.startsWith('gid://') ? SHOP_LOC : 'gid://shopify/Location/' + SHOP_LOC;
  const d = await shopGQL('{ locations(first: 1) { edges { node { id name } } } }');
  SHOP_LOC = d.locations.edges[0]?.node?.id || ''; if (!SHOP_LOC) throw new Error('Shopify: la tienda no tiene ubicaciones');
  return SHOP_LOC;
}
async function shopSetStock(items) {
  const loc = await shopLocation(), out = [], quantities = [];
  for (const it of items.slice(0, 100)) {
    const sku = String(it.sku || '').trim(); if (!sku) continue;
    const d = await shopGQL('query($q:String!){ productVariants(first: 1, query: $q) { edges { node { id sku inventoryItem { id } } } } }', { q: 'sku:' + JSON.stringify(sku) });
    const v = d.productVariants.edges[0]?.node;
    if (!v) { out.push({ sku, ok: false, error: 'SKU no existe en Shopify' }); continue; }
    quantities.push({ inventoryItemId: v.inventoryItem.id, locationId: loc, quantity: Math.max(0, Math.floor(+it.qty || 0)) });
    out.push({ sku, ok: true, qty: Math.max(0, Math.floor(+it.qty || 0)) });
  }
  if (quantities.length) {
    const d = await shopGQL('mutation($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input: $input) { userErrors { field message } } }',
      { input: { name: 'available', reason: 'correction', ignoreCompareQuantity: true, quantities } });
    const ue = d.inventorySetQuantities.userErrors || [];
    if (ue.length) throw new Error('Shopify: ' + ue.map(x => x.message).join('; '));
  }
  return out;
}
/* ---------- Mercado Libre ---------- */
async function mlToken(force) {
  if (!force && mlTok && Date.now() < mlExp - 120e3) return mlTok;
  if (!ML_ID || !ML_SECRET || !ML_REFRESH) { const e = new Error('Mercado Libre no está configurado en el puente (ML_CLIENT_ID, ML_CLIENT_SECRET, ML_REFRESH_TOKEN)'); e.status = 400; throw e; }
  const r = await fetch('https://api.mercadolibre.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: ML_ID, client_secret: ML_SECRET, refresh_token: ML_REFRESH }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error('Mercado Libre: no se pudo renovar el token (' + (j.message || r.status) + ')'); e.status = 502; throw e; }
  mlTok = j.access_token; mlExp = Date.now() + (j.expires_in || 21600) * 1000;
  if (j.refresh_token && j.refresh_token !== ML_REFRESH) { ML_REFRESH = j.refresh_token; log('ML: refresh_token renovado (actualiza ML_REFRESH_TOKEN si reinicias el puente):', ML_REFRESH.slice(0, 12) + '…'); }
  if (!mlSeller && j.user_id) mlSeller = String(j.user_id);
  return mlTok;
}
async function ml(path, opt = {}, retry = true) {
  const t = await mlToken();
  const r = await fetch('https://api.mercadolibre.com' + path, { ...opt, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(opt.headers || {}) } });
  if (r.status === 401 && retry) { await mlToken(true); return ml(path, opt, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Mercado Libre: ' + (j.message || j.error || r.status)); e.status = 502; throw e; }
  return j;
}
async function mlOrders(since) {
  await mlToken();
  const q = new URLSearchParams({ seller: mlSeller, sort: 'date_desc', limit: '50' });
  if (since) q.set('order.date_created.from', new Date(+since || since).toISOString().replace('Z', '-00:00'));
  const j = await ml('/orders/search?' + q);
  return (j.results || []).map(o => ({
    origen: 'ML', id: String(o.id), numero: String(o.pack_id || o.id), fecha: Date.parse(o.date_created),
    cliente: { nombre: [o.buyer?.first_name, o.buyer?.last_name].filter(Boolean).join(' ') || o.buyer?.nickname || 'Comprador ML', nickname: o.buyer?.nickname || '', telefono: '' },
    items: (o.order_items || []).map(li => ({ itemId: li.item?.id, sku: li.item?.seller_sku || '', titulo: li.item?.title, cantidad: li.quantity, precio: +li.unit_price })),
    moneda: o.currency_id, total: +o.total_amount, envio: 0, pagado: o.status === 'paid', estadoPago: o.status,
    cancelado: o.status === 'cancelled', envioId: o.shipping?.id || null, nota: ''
  }));
}
async function mlSetStock(items) {
  const out = [];
  for (const it of items.slice(0, 50)) {
    if (!it.itemId) continue;
    try { await ml('/items/' + encodeURIComponent(it.itemId), { method: 'PUT', body: JSON.stringify({ available_quantity: Math.max(0, Math.floor(+it.qty || 0)) }) }); out.push({ itemId: it.itemId, ok: true }); }
    catch (e) { out.push({ itemId: it.itemId, ok: false, error: e.message }); }
  }
  return out;
}

function cors(req, res) {
  const o = req.headers.origin;
  const ok = ORIGINS.includes('*') ? '*' : (o && ORIGINS.includes(o) ? o : ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Origin', ok || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bridge-key, x-spidi-env');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function body(req, limit = 1e6) {
  return new Promise((ok, ko) => { let b = ''; req.on('data', c => { b += c; if (b.length > limit) { ko(new Error('Cuerpo demasiado grande')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', ko); });
}
function authed(req) { return BRIDGE_KEY && safeEq(req.headers['x-bridge-key'] || '', BRIDGE_KEY); }

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const out = { ok: true, env: ENV, configured: !!(SHORT_NAME && PASSWORD && BRIDGE_KEY), agreement: !!AGREEMENT_ID,
        modules: { spidi: !!(SHORT_NAME && PASSWORD), shopify: shopOn(), ml: !!(ML_ID && ML_SECRET && ML_REFRESH) } };
      if (url.searchParams.get('check') === '1') {
        if (!authed(req)) return send(res, 401, { ok: false, error: 'Clave del puente incorrecta' });
        const only = url.searchParams.get('only');
        if ((!only || only === 'spidi') && out.modules.spidi) { try { await login(true); out.spidi = 'ok'; } catch (e) { out.spidi = 'error'; out.detail = e.message; } }
        if ((!only || only === 'shopify') && out.modules.shopify) { try { const d = await shopGQL('{ shop { name } }'); out.shopify = 'ok'; out.shopName = d.shop.name; } catch (e) { out.shopify = 'error'; out.shopifyDetail = e.message; } }
        if ((!only || only === 'ml') && out.modules.ml) { try { await mlToken(true); const me = await ml('/users/me'); out.ml = 'ok'; out.mlNick = me.nickname; } catch (e) { out.ml = 'error'; out.mlDetail = e.message; } }
      }
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/webhook/spidi') {
      const raw = await body(req);
      let j = {}; try { j = JSON.parse(raw); } catch {}
      const id = j?.data?.session_payment?.id;
      log('webhook', j.event || '?', id || '-');
      // No se confía en el contenido del aviso: se vuelve a consultar el estado en la API de SPIDI.
      if (id) { cache.delete(id); status(id).then(d => log('verificado', id, d.status)).catch(e => log('verificación falló', id, e.message)); }
      return send(res, 200, { ok: true });
    }
    if (!authed(req)) return send(res, 401, { ok: false, error: 'Clave del puente incorrecta' });

    if (req.method === 'POST' && url.pathname === '/sessions') {
      const b = JSON.parse((await body(req, 2e4)) || '{}');
      const amount = Math.round(+b.amount * 100) / 100;
      const currency = ['USD', 'VES', 'EUR', 'USDT', 'COP'].includes(b.currency) ? b.currency : 'USD';
      if (!(amount > 0)) return send(res, 400, { ok: false, error: 'Monto inválido' });
      if (currency === 'USD' && amount > MAX_USD) return send(res, 400, { ok: false, error: 'Monto mayor al límite del puente (' + MAX_USD + ' USD)' });
      const item = {
        title: String(b.identifier || 'Firefly').slice(0, 80),
        currency_reference: currency, amount_reference: amount, agreement_id: AGREEMENT_ID,
        identifier_label: String(b.identifier_label || 'Pedido').slice(0, 60),
        identifier: String(b.identifier || '—').slice(0, 120),
        description: String(b.description || 'Pago Firefly').slice(0, 480)
      };
      if (PUBLIC_URL) item.webhook_url = PUBLIC_URL + '/webhook/spidi';
      if (b.success_url) item.success_url = String(b.success_url);
      if (b.failure_url) item.failure_url = String(b.failure_url);
      const j = await spidi('/api/v1/ext/payment-sessions/request/batch', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ continue_on_error: false, items: [item] }) });
      const s = j?.data?.items?.[0];
      if (!s || !s.session_id) { const er = j?.data?.errors?.[0]; return send(res, 502, { ok: false, error: (er && (er.message || JSON.stringify(er))) || 'SPIDI no devolvió la sesión' }); }
      log('sesión creada', s.session_id, amount, currency, b.identifier || '');
      return send(res, 200, { ok: true, session: { session_id: s.session_id, payment_url: s.payment_url, payment_qr: s.payment_qr || null, status: 'pending', amount_reference: amount, currency_reference: currency } });
    }
    if (req.method === 'GET' && url.pathname === '/shopify/orders') return send(res, 200, { ok: true, orders: await shopOrders(url.searchParams.get('since')) });
    if (req.method === 'POST' && url.pathname === '/shopify/inventory') { const b = JSON.parse((await body(req, 2e5)) || '{}'); return send(res, 200, { ok: true, results: await shopSetStock(Array.isArray(b.items) ? b.items : []) }); }
    if (req.method === 'GET' && url.pathname === '/ml/orders') return send(res, 200, { ok: true, orders: await mlOrders(url.searchParams.get('since')) });
    if (req.method === 'POST' && url.pathname === '/ml/stock') { const b = JSON.parse((await body(req, 2e5)) || '{}'); return send(res, 200, { ok: true, results: await mlSetStock(Array.isArray(b.items) ? b.items : []) }); }
    const m = url.pathname.match(/^\/sessions\/([\w-]{8,80})$/);
    if (req.method === 'GET' && m) {
      const d = await status(m[1]);
      return send(res, 200, { ok: true, session: {
        session_id: d.session_id || m[1], status: d.status, amount_reference: d.amount_reference, currency_reference: d.currency_reference,
        payment_method: d.payment_method, spidi_transaction_url: d.spidi_transaction_url, payment_details: d.payment_details || null } });
    }
    return send(res, 404, { ok: false, error: 'Ruta no encontrada' });
  } catch (e) {
    log('error', req.method, url.pathname, e.message);
    return send(res, e.status && e.status < 500 ? e.status : 502, { ok: false, error: e.message });
  }
});
server.listen(PORT, () => log(`Puente Firefly escuchando en :${PORT} · SPIDI ${ENV} ${SHORT_NAME ? 'on' : 'off'} · Shopify ${SHOP ? 'on' : 'off'} · Mercado Libre ${ML_ID ? 'on' : 'off'}`));
