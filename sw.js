/* Firefly panel · service worker v16
   - index.html: se sirve al instante desde caché y se actualiza en segundo plano (stale-while-revalidate)
   - librerías (Firebase, fuentes, QR): caché primero
   - Firestore, Storage, Graph y el puente: nunca se cachean */
const V='ff-v16';
const SHELL=['./','./index.html'];
const CDN=/^(https:\/\/(www\.gstatic\.com\/firebasejs|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com))/;
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.origin===location.origin&&(u.pathname==='/'||u.pathname.endsWith('/index.html'))){
    e.respondWith(caches.open(V).then(async c=>{const hit=await c.match('./index.html');const net=fetch(r).then(res=>{if(res&&res.ok)c.put('./index.html',res.clone());return res;}).catch(()=>null);return hit||(await net)||new Response('Sin conexión',{status:503});}));return;}
  if(CDN.test(r.url)){e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(r);if(hit)return hit;const res=await fetch(r).catch(()=>null);if(res&&res.ok)c.put(r,res.clone());return res||new Response('',{status:504});}));return;}
});
