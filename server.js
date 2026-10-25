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
    const d = await shopGQL('query($q:String!,$loc:ID!){ productVariants(first: 1, query: $q) { edges { node { id sku inventoryItem { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } } } } }', { q: 'sku:' + JSON.stringify(sku), loc });
    const v = d.productVariants.edges[0]?.node;
    if (!v) { out.push({ sku, ok: false, error: 'SKU no existe en Shopify' }); continue; }
    let lvl = v.inventoryItem.inventoryLevel; if (!lvl) { await shopGQL('mutation($id:ID!,$loc:ID!){ inventoryActivate(inventoryItemId: $id, locationId: $loc) { userErrors { message } } }', { id: v.inventoryItem.id, loc }); lvl = { quantities: [{ quantity: 0 }] }; } quantities.push({ inventoryItemId: v.inventoryItem.id, locationId: loc, quantity: Math.max(0, Math.floor(+it.qty || 0)), changeFromQuantity: lvl.quantities?.[0]?.quantity ?? 0 });
    out.push({ sku, ok: true, qty: Math.max(0, Math.floor(+it.qty || 0)) });
  }
  if (quantities.length) {
    const d = await shopGQL('mutation($input: InventorySetQuantitiesInput!){ inventorySetQuantities(input: $input) @idempotent(key: "' + crypto.randomUUID() + '") { userErrors { field message } } }',
      { input: { name: 'available', reason: 'correction', quantities } });
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

/* ============================================================
   Meta → Firefly · webhook de WhatsApp Cloud API, Instagram y Messenger
   Guarda las conversaciones en Firestore (REST + cuenta de servicio),
   saluda automáticamente, pregunta la sede y asigna al vendedor.
   Variables: FIREBASE_SA (JSON de la cuenta de servicio), opcional
   FIREBASE_PROJECT, FIREBASE_BUCKET, WA_VERIFY_TOKEN (respaldo).
   ============================================================ */
const FB_SA = (() => { try { return JSON.parse(process.env.FIREBASE_SA || ''); } catch { return null; } })();
const FB_PROJECT = process.env.FIREBASE_PROJECT || (FB_SA && FB_SA.project_id) || 'firefly-vzla';
const FB_BUCKET = process.env.FIREBASE_BUCKET || (FB_PROJECT + '.firebasestorage.app');
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;
const GRAPH = 'https://graph.facebook.com/v19.0/';
const metaStats = { hits: 0, last: null, lastError: null, msgs: 0 };
let gTok = { token: '', exp: 0 };
function b64u(s) { return Buffer.from(s).toString('base64url'); }
async function gToken() {
  if (!FB_SA) throw new Error('FIREBASE_SA no configurada');
  if (gTok.token && Date.now() < gTok.exp - 60e3) return gTok.token;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: FB_SA.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_write', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), FB_SA.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + sig });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google OAuth: ' + (j.error_description || j.error || r.status));
  gTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gTok.token;
}
function fv(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fv) } };
  if (typeof v === 'object') return { mapValue: { fields: enc(v) } };
  return { stringValue: String(v) };
}
function enc(o) { const f = {}; for (const k in o) if (o[k] !== undefined) f[k] = fv(o[k]); return f; }
function dec(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue; if ('integerValue' in v) return +v.integerValue; if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue; if ('nullValue' in v) return null; if (v.timestampValue) return Date.parse(v.timestampValue);
  if (v.arrayValue) return (v.arrayValue.values || []).map(dec); if (v.mapValue) return decFields(v.mapValue.fields || {});
  return null;
}
function decFields(f) { const o = {}; for (const k in f) o[k] = dec(f[k]); return o; }
async function fsReq(path, opt = {}) {
  const tok = await gToken();
  const r = await fetch(FS_BASE + path, { ...opt, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Firestore ' + r.status + ': ' + (j.error && j.error.message || ''));
  return j;
}
async function fsGet(col, id) { const d = await fsReq(`/${col}/${encodeURIComponent(id)}`); return d ? { id, ...decFields(d.fields || {}) } : null; }
async function fsPatch(col, id, obj) {
  const mask = Object.keys(obj).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return fsReq(`/${col}/${encodeURIComponent(id)}?${mask}`, { method: 'PATCH', body: JSON.stringify({ fields: enc(obj) }) });
}
async function fsList(col, limit = 300) { const j = await fsReq(`/${col}?pageSize=${limit}`); return ((j && j.documents) || []).map(d => ({ id: d.name.split('/').pop(), ...decFields(d.fields || {}) })); }
async function fsQuery(col, field, value, limit = 5) {
  const j = await fsReq(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: fv(value) } }, limit } }) });
  return (j || []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), ...decFields(x.document.fields || {}) }));
}
const fsCache = new Map();
async function fsCached(key, ms, fn) { const c = fsCache.get(key); if (c && Date.now() - c.ts < ms) return c.v; const v = await fn(); fsCache.set(key, { ts: Date.now(), v }); return v; }
const metaCfg = () => fsCached('config', 60e3, () => fsGet('config', 'main'));
async function storageUpload(path, buf, contentType) {
  const tok = await gToken();
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${FB_BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': contentType || 'application/octet-stream' }, body: buf });
  if (!r.ok) throw new Error('Storage ' + r.status);
  return `https://firebasestorage.googleapis.com/v0/b/${FB_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}
async function graph(path, tok, opt = {}) {
  const r = await fetch(GRAPH + path + (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(tok), opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error && j.error.message || 'Graph ' + r.status);
  return j;
}
const telLocal = n => { const d = String(n || '').replace(/\D/g, ''); return d.startsWith('58') && d.length >= 12 ? '0' + d.slice(2) : d; };
const safeId = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
/* ---- saludo automático y asignación por sede ---- */
async function sedesRows() {
  const sedes = await fsCached('sedes', 5 * 60e3, () => fsList('sedes'));
  const rows = sedes.filter(s => s.activo !== false).map(s => ({ id: 'sede_' + s.id, title: String(s.nombre || s.codigo || 'Sede').slice(0, 24) })).slice(0, 9);
  rows.push({ id: 'sede_resto', title: 'Resto del país' });
  return { sedes, rows };
}
async function elegirVendedor(sedeId) {
  const users = await fsCached('usuarios', 5 * 60e3, () => fsList('usuarios'));
  let pool = users.filter(u => u.activo !== false && u.rol === 'vendedor' && (sedeId === 'resto' ? (u.sedeId === 'resto' || !u.sedeId) : u.sedeId === sedeId));
  if (!pool.length) pool = users.filter(u => u.activo !== false && u.rol === 'vendedor');
  if (!pool.length) return null;
  pool.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rr = (await fsGet('config', 'rr')) || {};
  const i = (+rr[sedeId] || 0) % pool.length;
  await fsPatch('config', 'rr', { [sedeId]: i + 1 }).catch(() => {});
  return pool[i];
}
async function asignarConv(conv, sedeKey, cfg) {
  const { sedes } = await sedesRows();
  const sedeId = sedeKey === 'resto' ? 'resto' : sedeKey;
  const sede = sedes.find(s => s.id === sedeId);
  const v = await elegirVendedor(sedeId);
  const now = Date.now();
  const patch = { sedeId: sedeId === 'resto' ? '' : sedeId, sedeNombre: sede ? (sede.nombre || sede.codigo) : 'Resto del país', sedeElegida: now };
  if (v) Object.assign(patch, { asignadoId: v.id, asignadoNombre: v.nombre || '', asignadoTs: now, asignadoPor: 'Firefly (automático)', estado: 'CONTACTADO' });
  // cliente ligado
  const clId = conv.clienteId || ('cl_' + conv.id);
  await fsPatch('clientes', clId, { nombre: conv.name || 'Cliente', telefono: conv.tel || '', ig: conv.plat === 'Instagram' ? (conv.name || '') : '', igId: conv.plat === 'Instagram' ? (conv.uid || '') : '', fbId: conv.plat === 'Facebook' ? (conv.uid || '') : '', canal: conv.plat, origen: 'Mensaje', estado: v ? 'CONTACTADO' : 'NUEVO', creado: conv.creado || now, actualizado: now, tags: [], pedidoIds: [], pedidos: 0, totalUSD: 0, sedeId: patch.sedeId, ...(v ? { vendedorId: v.id, vendedorNombre: v.nombre || '', asignadoTs: now, asignadoPor: 'Firefly (automático)', fu: { inicio: now, hechos: {}, activo: true } } : {}) }).catch(e => log('cliente', e.message));
  patch.clienteId = clId;
  await fsPatch('conversaciones', conv.id, patch);
  if (v) {
    await fsPatch('notifs', 'nf_auto_' + conv.id, { paraId: v.id, titulo: `Nuevo lead de ${conv.plat}: ${conv.name || 'cliente'}`, sub: `${patch.sedeNombre} · ${(conv.last || '').slice(0, 80)} · Inicia el follow-up #1 hoy`, r: 'inbox', arg: conv.id, tipo: 'lead', ts: now, leido: false, deId: '', deNombre: 'Firefly' }).catch(() => {});
    const txt = (cfg.waCloud && cfg.waCloud.saludoOk || 'Perfecto. {vendedor} de nuestro equipo en {sede} te atenderá en un momento.').replace('{vendedor}', (v.nombre || 'Un asesor').split(' ')[0]).replace('{sede}', patch.sedeNombre);
    await enviarTexto(conv, txt, cfg).catch(e => log('saludoOk', e.message));
  }
  return v;
}
async function enviarTexto(conv, txt, cfg) {
  if (conv.plat === 'WhatsApp') {
    const w = cfg.waCloud || {}; const tok = w.token || cfg.metaPageToken; if (!w.phoneId || !tok) return;
    await graph(`${w.phoneId}/messages`, tok, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: conv.uid, type: 'text', text: { body: txt } }) });
  } else {
    if (!cfg.metaPageId || !cfg.metaPageToken) return;
    await graph(`${cfg.metaPageId}/messages`, cfg.metaPageToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: conv.uid }, message: { text: txt }, messaging_type: 'RESPONSE' }) });
  }
  await appendMsg(conv.id, { ts: Date.now(), from: 'me', por: 'Firefly (auto)', txt }, true);
}
async function saludar(conv, cfg) {
  const w = cfg.waCloud || {};
  if (w.saludoAuto === false) return;
  const { rows } = await sedesRows();
  const nombre = (conv.name || '').split(' ')[0];
  const body = (w.saludo || 'Hola {nombre}, gracias por escribir a Firefly. Para atenderte mejor, cuéntanos en qué ciudad te encuentras:').replace('{nombre}', nombre || '').replace(/\s{2,}/g, ' ');
  if (conv.plat === 'WhatsApp') {
    const tok = w.token || cfg.metaPageToken; if (!w.phoneId || !tok) return;
    await graph(`${w.phoneId}/messages`, tok, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: conv.uid, type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button: 'Elegir ciudad', sections: [{ title: 'Nuestras sedes', rows }] } } }) });
  } else {
    if (!cfg.metaPageId || !cfg.metaPageToken) return;
    await graph(`${cfg.metaPageId}/messages`, cfg.metaPageToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: conv.uid }, messaging_type: 'RESPONSE', message: { text: body, quick_replies: rows.slice(0, 13).map(r => ({ content_type: 'text', title: r.title.slice(0, 20), payload: r.id })) } }) });
  }
  await appendMsg(conv.id, { ts: Date.now(), from: 'me', por: 'Firefly (auto)', txt: body + ' [' + rows.map(r => r.title).join(' / ') + ']' }, true);
  await fsPatch('conversaciones', conv.id, { saludoTs: Date.now() });
}
async function appendMsg(convId, m, mine) {
  const cur = await fsGet('conversaciones', convId);
  const msgs = ((cur && cur.msgs) || []).concat([m]).slice(-300);
  const p = { msgs, last: m.txt || ('Archivo: ' + (m.fname || 'adjunto')), lastMine: !!mine, t: m.ts, lastTs: m.ts };
  if (!mine) p.unread = ((cur && cur.unread) || 0) + 1;
  await fsPatch('conversaciones', convId, p);
  return cur;
}
async function sedeDesdeTexto(txt) {
  const { sedes } = await sedesRows(); const t = String(txt || '').toLowerCase();
  if (/resto|otra ciudad|otro estado|interior|env[ií]o/.test(t)) return 'resto';
  const s = sedes.find(s => [s.nombre, s.codigo].filter(Boolean).some(n => t.includes(String(n).toLowerCase())));
  return s ? s.id : null;
}
async function waMedia(mediaId, tok, convId, kind) {
  try {
    const meta = await graph(mediaId, tok);
    const r = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + tok } });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = meta.mime_type || r.headers.get('content-type') || 'application/octet-stream';
    const ext = (ct.split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg').replace('ogg', 'ogg');
    return await storageUpload(`chats/${convId}/${Date.now()}_${kind}.${ext}`, buf, ct);
  } catch (e) { log('media', e.message); return ''; }
}
/* ---- WhatsApp ---- */
async function waEvento(value, cfg) {
  const w = cfg.waCloud || {}; const tok = w.token || cfg.metaPageToken;
  const contacts = value.contacts || [];
  for (const m of (value.messages || [])) {
    const from = m.from; const convId = 'wa_' + safeId(from);
    const c = contacts.find(x => x.wa_id === from); const name = (c && c.profile && c.profile.name) || telLocal(from);
    const ts = (+m.timestamp || Math.floor(Date.now() / 1000)) * 1000;
    let txt = '', extra = {};
    if (m.type === 'text') txt = m.text && m.text.body || '';
    else if (m.type === 'interactive') { const r = m.interactive && (m.interactive.list_reply || m.interactive.button_reply); txt = r ? r.title : ''; extra.payload = r ? r.id : ''; }
    else if (m.type === 'button') { txt = m.button && m.button.text || ''; extra.payload = m.button && m.button.payload || ''; }
    else if (['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)) { const md = m[m.type] || {}; txt = md.caption || ''; const url = tok ? await waMedia(md.id, tok, convId, m.type) : ''; if (url) { if (m.type === 'image' || m.type === 'sticker') extra.img = url; else if (m.type === 'video') extra.vid = url; else if (m.type === 'audio') extra.aud = url; else extra.file = url; extra.fname = md.filename || m.type; } }
    else if (m.type === 'location') { const l = m.location || {}; txt = `Ubicación: https://maps.google.com/?q=${l.latitude},${l.longitude}${l.name ? ' · ' + l.name : ''}`; }
    else txt = '(' + m.type + ')';
    let cur = await fsGet('conversaciones', convId);
    const nuevo = !cur;
    if (nuevo) { await fsPatch('conversaciones', convId, { plat: 'WhatsApp', fuente: 'wa', name, tel: telLocal(from), uid: from, creado: ts, estado: 'NUEVO', asignadoId: '', unread: 0, msgs: [] }); cur = await fsGet('conversaciones', convId); }
    else if (name && cur.name !== name && /^\d+$/.test(cur.name || '')) await fsPatch('conversaciones', convId, { name });
    await appendMsg(convId, { ts, from: 'cl', txt, waId: m.id, ...extra }, false);
    metaStats.msgs++;
    const conv = { ...(cur || {}), id: convId, plat: 'WhatsApp', uid: from, name, tel: telLocal(from), last: txt, creado: cur ? cur.creado : ts };
    // ¿respondió la sede?
    const sedeKey = extra.payload && extra.payload.startsWith('sede_') ? extra.payload.slice(5) : (!conv.asignadoId && conv.saludoTs ? await sedeDesdeTexto(txt) : null);
    if (sedeKey && !conv.asignadoId) { await asignarConv(conv, sedeKey, cfg).catch(e => log('asignar', e.message)); continue; }
    if (nuevo || (!conv.saludoTs && !conv.asignadoId)) { await saludar(conv, cfg).catch(e => log('saludo', e.message)); }
  }
}
/* ---- Instagram / Messenger ---- */
async function pageEvento(platform, entry, cfg) {
  if (!cfg.metaPageId || !cfg.metaPageToken) return;
  const me = [cfg.metaPageId, cfg.metaIgUserId].filter(Boolean);
  for (const ev of (entry.messaging || [])) {
    const msg = ev.message; if (!msg || msg.is_echo) continue;
    const sender = ev.sender && ev.sender.id; if (!sender || me.includes(sender)) continue;
    const ts = ev.timestamp || Date.now();
    let conv = (await fsQuery('conversaciones', 'uid', sender, 1))[0] || null;
    let convId = conv && conv.id;
    let name = conv && conv.name || '';
    if (!conv) {
      let metaId = '';
      try { const j = await graph(`${cfg.metaPageId}/conversations?platform=${platform}&user_id=${sender}&fields=id,participants`, cfg.metaPageToken); const cv = (j.data || [])[0]; if (cv) { metaId = cv.id; const who = (cv.participants && cv.participants.data || []).find(p => !me.includes(p.id)); name = who && (who.username || who.name) || ''; } } catch (e) { log('conv lookup', e.message); }
      if (!name) { try { const u = await graph(`${sender}?fields=name,username`, cfg.metaPageToken); name = u.username || u.name || ''; } catch {} }
      convId = metaId ? 'mt_' + safeId(metaId) : (platform === 'instagram' ? 'ig_' : 'fb_') + safeId(sender);
      await fsPatch('conversaciones', convId, { metaId: metaId || '', plat: platform === 'instagram' ? 'Instagram' : 'Facebook', fuente: metaId ? 'meta' : 'manual', name: name || 'Cliente', uid: sender, creado: ts, estado: 'NUEVO', asignadoId: '', unread: 0, msgs: [] });
      conv = await fsGet('conversaciones', convId);
    }
    const txt = msg.text || '';
    const at = (msg.attachments || [])[0]; const extra = {};
    if (at && at.payload && at.payload.url) { if (at.type === 'image') extra.img = at.payload.url; else if (at.type === 'video') extra.vid = at.payload.url; else if (at.type === 'audio') extra.aud = at.payload.url; else extra.file = at.payload.url; }
    if (msg.quick_reply && msg.quick_reply.payload) extra.payload = msg.quick_reply.payload;
    // para conversaciones que la app lee desde Graph (fuente meta) solo actualizamos el resumen; para las demás guardamos el mensaje
    if (conv.fuente === 'meta') await fsPatch('conversaciones', convId, { last: txt || 'Adjunto', lastMine: false, t: ts, lastTs: ts, unread: (conv.unread || 0) + 1 });
    else await appendMsg(convId, { ts, from: 'cl', txt, ...extra }, false);
    metaStats.msgs++;
    const c2 = { ...conv, id: convId, uid: sender, name: conv.name || name, last: txt };
    const sedeKey = extra.payload && extra.payload.startsWith('sede_') ? extra.payload.slice(5) : (!c2.asignadoId && c2.saludoTs ? await sedeDesdeTexto(txt) : null);
    if (sedeKey && !c2.asignadoId) { await asignarConv(c2, sedeKey, cfg).catch(e => log('asignar', e.message)); continue; }
    if (!c2.saludoTs && !c2.asignadoId) await saludar(c2, cfg).catch(e => log('saludo', e.message));
  }
}
async function metaWebhook(j) {
  const cfg = (await metaCfg()) || {};
  for (const entry of (j.entry || [])) {
    if (j.object === 'whatsapp_business_account') { for (const ch of (entry.changes || [])) if (ch.field === 'messages' && ch.value) await waEvento(ch.value, cfg); }
    else if (j.object === 'instagram') await pageEvento('instagram', entry, cfg);
    else if (j.object === 'page') await pageEvento('messenger', entry, cfg);
  }
}
async function metaVerify(url) {
  const mode = url.searchParams.get('hub.mode'), tok = url.searchParams.get('hub.verify_token'), ch = url.searchParams.get('hub.challenge');
  let expected = process.env.WA_VERIFY_TOKEN || '';
  if (!expected && FB_SA) { try { const c = await metaCfg(); expected = (c && c.waCloud && c.waCloud.verifyToken) || (c && c.metaVerifyToken) || ''; } catch (e) { log('verify cfg', e.message); } }
  return mode === 'subscribe' && expected && tok && safeEq(tok, expected) ? ch : null;
}
function metaSignatureOk(raw, header, secret) {
  if (!secret) return true; if (!header) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return safeEq(mac, header);
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
        modules: { spidi: !!(SHORT_NAME && PASSWORD), shopify: shopOn(), ml: !!(ML_ID && ML_SECRET && ML_REFRESH), meta: !!FB_SA },
        webhook: PUBLIC_URL ? PUBLIC_URL + '/webhook/meta' : '', meta: { sa: !!FB_SA, project: FB_PROJECT, hits: metaStats.hits, last: metaStats.last, msgs: metaStats.msgs, lastError: metaStats.lastError } };
      if (url.searchParams.get('check') === '1') {
        if (!authed(req)) return send(res, 401, { ok: false, error: 'Clave del puente incorrecta' });
        const only = url.searchParams.get('only');
        if ((!only || only === 'spidi') && out.modules.spidi) { try { await login(true); out.spidi = 'ok'; } catch (e) { out.spidi = 'error'; out.detail = e.message; } }
        if ((!only || only === 'shopify') && out.modules.shopify) { try { const d = await shopGQL('{ shop { name } }'); out.shopify = 'ok'; out.shopName = d.shop.name; } catch (e) { out.shopify = 'error'; out.shopifyDetail = e.message; } }
        if ((!only || only === 'meta') && FB_SA) { try { const c = await fsGet('config', 'main'); out.firestore = c ? 'ok' : 'sin config'; out.verifyToken = !!(c && c.waCloud && c.waCloud.verifyToken); } catch (e) { out.firestore = 'error'; out.firestoreDetail = e.message; } }
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
    if (url.pathname === '/webhook/whatsapp' || url.pathname === '/webhook/meta') {
      if (req.method === 'GET') { const ch = await metaVerify(url); if (ch) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ch); } return send(res, 403, { ok: false, error: 'Verify token incorrecto' }); }
      if (req.method === 'POST') {
        const raw = await body(req, 3e6); metaStats.hits++; metaStats.last = Date.now();
        let cfg = null; try { cfg = await metaCfg(); } catch (e) { metaStats.lastError = e.message; }
        const secret = (cfg && cfg.metaAppSecret) || process.env.META_APP_SECRET || '';
        if (!metaSignatureOk(raw, req.headers['x-hub-signature-256'], secret)) { log('webhook meta: firma inválida'); return send(res, 403, { ok: false, error: 'Firma inválida' }); }
        let j = {}; try { j = JSON.parse(raw); } catch {}
        send(res, 200, { ok: true });
        metaWebhook(j).catch(e => { metaStats.lastError = e.message; log('meta webhook', e.message); });
        return;
      }
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
server.listen(PORT, () => log(`Puente Firefly escuchando en :${PORT} · SPIDI ${ENV} ${SHORT_NAME ? 'on' : 'off'} · Shopify ${SHOP ? 'on' : 'off'} · Mercado Libre ${ML_ID ? 'on' : 'off'} · Meta webhook ${FB_SA ? 'on' : 'sin FIREBASE_SA'}`));
