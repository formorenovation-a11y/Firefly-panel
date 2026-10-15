# Puente Firefly (SPIDI · Shopify · Mercado Libre)

> Desde la v11 este mismo servidor también conecta **Shopify** y **Mercado Libre**. Si ya tenías publicado el puente de SPIDI, solo vuelve a subir esta carpeta y agrega las variables nuevas; cada integración se activa sola cuando sus variables existen.

Este pequeño servidor conecta el panel de Firefly con la API de SPIDI. Así, al cobrar un pedido, la app genera un link y un QR por el monto exacto y marca el pago como recibido cuando SPIDI lo confirma.

**¿Por qué un puente?** La API de SPIDI se usa con tu usuario y contraseña de comercio. Si esos datos estuvieran dentro de la app, cualquiera que la abra podría verlos. Por eso el puente es lo único que los guarda (como variables de entorno), y la app solo puede pedirle dos cosas:

1. Crear un cobro hacia tu cuenta.
2. Consultar el estado de ese cobro.

No hay ninguna forma de mover dinero hacia afuera.

## 1. Pídele a SPIDI tus datos de API
Escribe a **hola@mispidi.com** para activar la cuenta comercial. Pide:
- usuario de API (`short_name`) y contraseña
- tu `agreement_id`, que define a qué cuenta bancaria se liquida
- acceso al **sandbox**, para hacer pruebas antes de pasar a producción

## 2. Publícalo en Render (gratis)
1. Sube esta carpeta (`spidi-bridge`) a un repositorio de GitHub. Puede ser el mismo del panel, en una subcarpeta.
2. En Render ve a **New → Web Service** y elige el repositorio.
   - Si el puente está en una subcarpeta, pon esa carpeta en **Root Directory**.
   - En Build command escribe `echo ok`.
   - En Start command escribe `node server.js`.
   - Si prefieres, usa **New → Blueprint** con el archivo `render.yaml` y Render lo configura solo.
3. En **Environment** agrega estas variables:

| Variable | Valor |
|---|---|
| `SPIDI_ENV` | `sandbox` para pruebas, `production` para cobrar de verdad |
| `SPIDI_SHORT_NAME` | tu usuario de API de SPIDI |
| `SPIDI_PASSWORD` | tu contraseña de API de SPIDI |
| `SPIDI_AGREEMENT_ID` | el agreement que te dio SPIDI |
| `BRIDGE_KEY` | una clave larga inventada por ti, que también pegas en la app |
| `ALLOWED_ORIGINS` | la dirección de tu panel, por ejemplo `https://firefly-panel.onrender.com` |
| `PUBLIC_URL` | la URL de este puente (opcional; sirve para que SPIDI avise al instante) |
| `MAX_AMOUNT_USD` | (opcional) el monto máximo por cobro; por defecto es 5000 |

4. Abre `https://TU-PUENTE.onrender.com/health`. Debe responder `{"ok":true,...}`.

## 3. Conéctalo en Firefly
En **Ajustes → Integraciones → SPIDI**:
1. Elige **Cobro automático**.
2. Pega la URL del puente y el `BRIDGE_KEY`.
3. Activa SPIDI y toca **Probar conexión**.

Si todo está bien, aparece “Conectado”.

## Cómo se usa
- En un pedido con saldo, toca **⋯ → Cobrar con SPIDI** o el botón del detalle. Se genera un link y un QR.
- Envíaselo al cliente por WhatsApp, o muéstraselo en la entrega.
- Cuando el cliente paga, la app registra el pago solo:
  - método SPIDI
  - monto en $ y en Bs
  - referencia bancaria y banco
- Si cerraste la ventana antes de que pagara, entra en **⋯ → Verificar pagos SPIDI** dentro del pedido.

> En el plan gratis de Render, el servidor se duerme si nadie lo usa. El primer cobro del día puede tardar unos 30 segundos.

## Rutas del puente
- `GET /health`: estado del puente. Con `?check=1` y la clave, además prueba el login en SPIDI.
- `POST /sessions`: recibe `{amount, currency, identifier, identifier_label, description}` y crea una sesión de cobro con `payment-sessions/request/batch`.
- `GET /sessions/:id`: devuelve el estado del cobro (`pending`, `paid`, `expired` o `failed`) con los detalles bancarios.
- `POST /webhook/spidi`: recibe los avisos de SPIDI. No confía en el contenido del aviso: vuelve a consultar el estado directamente en la API antes de darlo por bueno.

Para probarlo en tu computadora:
```
SPIDI_SHORT_NAME=... SPIDI_PASSWORD=... BRIDGE_KEY=... node server.js
```


---

## Shopify (importar pedidos y sincronizar stock)
Shopify ya no deja crear apps desde el admin de la tienda: ahora se crean en el **Dev Dashboard** (dev.shopify.com).
1. **Crear app** → nombre `App Firefly`.
2. **URLs**
   - App URL: `https://app.fireflyve.com` (con `https://`).
   - Desmarca **Embed app in Shopify admin** (Firefly abre en su propia página).
   - Allowed redirection URL(s): `https://app.fireflyve.com` (no se usa, pero el campo lo pide).
3. **API access → Scopes**: `read_orders,read_products,read_inventory,write_inventory,read_locations,read_customers`
4. **Webhooks API version**: deja la que viene (2026-10).
5. **Release / Guardar versión** y luego **Instalar** la app en la tienda de Firefly.
6. Si los pedidos llegan sin nombre o teléfono del cliente: en la app, sección *Protected customer data*, pide acceso a **Name, Phone y Address**.
7. En **Settings** de la app copia el **Client ID** y el **Client secret** y agrégalos en Render:

| Variable | Valor |
|---|---|
| `SHOPIFY_STORE` | `tutienda.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID de la app |
| `SHOPIFY_CLIENT_SECRET` | Client secret de la app |
| `SHOPIFY_LOCATION_ID` | opcional: ubicación de inventario (si no, usa la primera) |

El puente pide el token solo y lo renueva cada 24 h. (Si tienes una app vieja con token `shpat_…`, también sirve: ponlo en `SHOPIFY_ADMIN_TOKEN`.)

En Firefly, cada producto debe tener el **SKU** igual al de la variante en Shopify (Productos → Editar → SKU).
- **Importar pedidos**: Ajustes → Integraciones → Shopify → "Importar pedidos". Crea las órdenes con canal Shopify, descuenta inventario de la sede que elijas y no duplica pedidos ya importados.
- **Sincronizar stock**: envía a Shopify el disponible total (o el de la sede que elijas) de cada SKU.

## Mercado Libre (importar ventas y actualizar stock)
1. Crea una aplicación en **developers.mercadolibre.com.ve** (Mis aplicaciones → Crear). Activa los permisos de lectura/escritura de órdenes e ítems y una URL de redirección (por ejemplo `https://app.fireflyve.com`).
2. Autoriza tu cuenta de vendedor abriendo
   `https://auth.mercadolibre.com.ve/authorization?response_type=code&client_id=TU_CLIENT_ID&redirect_uri=TU_URL`
   y copia el `code` que aparece en la URL de regreso.
3. Cambia el `code` por tokens (una sola vez):
   ```
   curl -X POST https://api.mercadolibre.com/oauth/token \
     -d grant_type=authorization_code -d client_id=TU_CLIENT_ID -d client_secret=TU_SECRET \
     -d code=EL_CODE -d redirect_uri=TU_URL
   ```
4. Agrega en Render `ML_CLIENT_ID`, `ML_CLIENT_SECRET` y `ML_REFRESH_TOKEN` (el `refresh_token` de la respuesta).

El puente renueva el token solo. Mercado Libre entrega un `refresh_token` nuevo en cada renovación: el puente lo guarda en memoria y lo muestra en los logs. Si reinicias el servicio, actualiza `ML_REFRESH_TOKEN` con el último valor del log.

En Firefly, en cada producto escribe el **ID de la publicación** (MLV…) en Productos → Editar → Publicación → Mercado Libre.

## Probar
`GET /health` muestra qué módulos están activos. Desde Firefly, Ajustes → Integraciones → "Probar conexión" verifica SPIDI, Shopify y Mercado Libre con la clave del puente.
