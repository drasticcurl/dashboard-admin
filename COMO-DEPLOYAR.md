# Cómo deployar el panel

Documento **autocontenido**: entrar a la VPS, entender Cloudflare, deployar,
verificar y volver atrás sin abrir ningún otro repo. Verificado contra la
máquina el **2026-09-13** (ver §12 para qué se chequeó exactamente).

| | |
|---|---|
| **Repo** | `github.com/drasticcurl/dashboard-admin` (privado) |
| **Rama de producción** | `main` |
| **En la VPS** | `/srv/panel/` |
| **Dominio** | `https://panel.hilvanapp.com` → `127.0.0.1:3005` |
| **Zona de Cloudflare** | `hilvanapp.com` |
| **PM2** | `panel-3005` (la app) y `panel-reglas` (worker de reglas de ads) |
| **Base** | PostgreSQL 16.15 en `127.0.0.1:5432`, base `panel` (+ `panel_test`) |
| **Moneda de reporte** | EUR |

## ⚠️ Este repo deploya DOS instancias distintas

| | hilvanapp | infinix |
|---|---|---|
| Dominio | `panel.hilvanapp.com` | `panel.infinixapp.com` |
| Puerto / PM2 | 3005 · `panel-3005` | 3007 · `panel-infinix-3007` |
| Base | `panel` (+ `panel_test`) | `panel_infinix` (+ `panel_infinix_test`) |
| Moneda | EUR | USD |
| `PANEL_BRAND` | `Hilvan` (default) | `Infinix App` |
| Deploy | `/srv/panel/repo/deploy/deploy.sh` | **`/srv/panel-infinix/deploy.sh`** |
| Worker de reglas | `panel-reglas` corriendo | **no levantado a propósito** |

**El deploy de infinix vive FUERA del repo** (`/srv/panel-infinix/deploy.sh`, no
`.../repo/deploy/deploy.sh`) y eso es deliberado: su `repo/` es un clon del
mismo GitHub, y el `git reset --hard` del deploy borraría cualquier archivo
propio de la instancia guardado adentro. **Ninguna task de este repo puede
editarlo**: los cambios que necesite ese script se hacen a mano en el server.

Consecuencia práctica: **un cambio que mergeás acá se va a las dos instancias**
en su próximo deploy. Si agregás algo que dependa de la moneda o de la marca,
hacelo por env var con default al valor de hilvanapp. Un valor hardcodeado le
cambia el comportamiento a las dos.

Y `NEXT_PUBLIC_REPORT_CURRENCY` **no se cambia en una instancia con historial**:
los montos convertidos se congelan al insertar la venta y no se recalculan al
leer, así que cambiarla mezcla dos monedas en la misma columna sin que nada
falle. Ver `lib/moneda-reporte.ts`.

**El error más caro de esta topología es copiar el `.env.production` del stack
de al lado.** Los dos paneles tienen las mismas claves con valores distintos: un
env cruzado deja un panel escribiendo y leyendo la base del otro, y **no falla
nada** — el build pasa, los tests pasan, el health check pasa. Es el único error
acá que corrompe datos en vez de tirar el servicio. `/srv/panel-infinix/deploy.sh`
tiene un guard de identidad (verifica que `DATABASE_URL` termine en
`/panel_infinix` y que `NEXT_PUBLIC_SITE_URL` contenga `panel.infinixapp.com`);
**el deploy de hilvanapp todavía no lo tiene.**

---

## 1 · Entrar a la VPS

Un solo servidor Ubuntu 24.04.4 (4 cores, 8 GB RAM, 96 GB de disco) con dos
usuarios y **sin login por password**: solo clave SSH.

```bash
ssh funnel-vps        # usuario deploy → deploys, PM2, logs de la app, crons
ssh funnel-vps-root   # usuario root   → Caddy, ufw, certificados, psql, backups
```

| Usuario | Para qué | Puede |
|---|---|---|
| `deploy` | correr los deploys, los procesos y los crons | dueño de `/srv/*` y del daemon de PM2. **No tiene sudo** |
| `root` | infraestructura | Caddy, ufw, certs, `sudo -u postgres psql`, leer `/var/log/caddy/` |

### Si los alias no existen (máquina nueva)

```bash
cat >> ~/.ssh/config <<'EOF'

Host funnel-vps
	HostName <IP-DEL-ORIGEN>
	User deploy
	IdentityFile ~/.ssh/id_ed25519
	IdentitiesOnly yes
	ServerAliveInterval 30

Host funnel-vps-root
	HostName <IP-DEL-ORIGEN>
	User root
	IdentityFile ~/.ssh/id_ed25519
	IdentitiesOnly yes
	ServerAliveInterval 30
EOF
```

**La IP del origen no está en este repo a propósito**: es la IP detrás de
Cloudflare, y publicarla permite saltear la protección de DDoS pegándole
directo. Tres formas de obtenerla:

1. el `~/.ssh/config` de una máquina que ya entra;
2. Cloudflare → zona `hilvanapp.com` → DNS → el registro A de `panel` (la
   columna *Content*);
3. desde la VPS: `grep ORIGIN_IP /srv/chauhinchazon/shared/deploy.env` (el
   panel no tiene `deploy.env` propio, ver §5).

Y hay que **cargar tu clave pública** en `~/.ssh/authorized_keys` del usuario
(desde una sesión que ya tenga acceso). Sin clave no entrás.

### Lo primero al entrar

```bash
bash /srv/estado.sh      # mapa EN VIVO de los dos stacks, con release y HTTP local
sudo bash /srv/estado.sh # igual, más las bases y las últimas cotizaciones
cat /srv/PROYECTOS.md    # el porqué de los dos stacks y sus trampas
```

`estado.sh` tiene un chequeo hecho justo para el error del recuadro de arriba
(el env cruzado): compara el
`DATABASE_URL` de cada panel contra la base que le corresponde y avisa en rojo
si están cruzados.

`PROYECTOS.md` es del 2026-08-30 y quedó atrás en algún punto (dice que el
próximo puerto libre es el 3010, y hoy están tomados hasta el 3013 más el 3020
y el 3050). Cuando un documento y la máquina no coinciden, **la máquina tiene
razón**.

### Qué más vive en esta máquina

Verificado el 2026-09-13 con `pm2 status` y `/etc/caddy/Caddyfile`:

| Servicio | Dominio(s) | Puertos | PM2 | `/srv/` |
|---|---|---|---|---|
| Funnel Chau Hinchazón | `chauhinchazon.hilvanapp.com`, `ritual.hilvanapp.org` | 3001/3002 | `chauhinchazon-3001/3002` | `chauhinchazon` |
| Funnel Protocolo Reset+ | `reset.hilvanapp2.org` (+ `preview-reset`) | 3003/3004 | `reset-3003/3004` | `reset` |
| **Panel (este repo)** | **`panel.hilvanapp.com`** | **3005** | **`panel-3005` + `panel-reglas`** | **`panel`** |
| Generador de videos | `generador.hilvanapp.online` | 3006 | `generador-3006` | `generador` |
| **Panel infinix (mismo repo)** | **`panel.infinixapp.com`** | **3007** | **`panel-infinix-3007`** | **`panel-infinix`** |
| Funnel gatos | `gatos.infinixapp.com` | 3008/3009 | `gatos-3008/3009` | `gatos` |
| Funnel Gelatina Fit | `gelatina.hilvanapp.online` | 3010/3011 | `gelatina-3010/3011` | `gelatina` |
| Landing arroz | `landing.hilvanapp2.org` | 3012/3013 | `landing-3012/3013` | `landing` |
| Checkout hilvapay | `hilvapay.hilvanapp.com`, `pay.hilvanapp.com` | 3020 | `hilvapay-3020` | `hilvapay` |
| POC one-click Whop | `paytest.hilvanapp.com` | 3050 | `whop-oneclick-poc-3050` | `whop-oneclick-poc` |

Los funnels de la lista **le reportan a este panel** por `/api/ingest` con una
ingest key por funnel, y le mandan las ventas por webhook de Shopify. Hoy hay
cuatro funnels cargados en la base `panel`: `chauhinchazon`,
`chauhinchazon-latam`, `reset` y `gelatina`.

### Topología de un request

```
visitante
   ↓
Cloudflare       proxy naranja: TLS público, WAF, geo-block
   ↓             ufw solo deja pasar 80/443 desde los rangos de Cloudflare
Caddy :443       TLS con Origin CA, Cache-Control no-store, noindex
   ↓
Node 127.0.0.1:3005      una sola instancia, PM2 fork, Next standalone
   ↓
PostgreSQL 127.0.0.1:5432, base `panel`
```

**Una sola instancia a propósito**, a diferencia de los funnels: el rate-limit
del login vive en la memoria del proceso, y balancear entre dos duplicaría el
límite efectivo.

Postgres escucha en `localhost` únicamente (`listen_addresses = localhost`), y
ufw abre el 22 a todos y el 80/443 solo a los rangos de Cloudflare. Nada
escucha en una interfaz pública salvo Caddy.

**No hay Docker en la VPS.** Postgres es el paquete de Ubuntu. Si algún runbook
te manda a correr `docker exec panel-db-1 psql …`, está viejo: falla con
`command not found`. El `docker-compose.yml` de este repo es solo para
desarrollo local.

---

## 2 · Cloudflare

Las cinco zonas de la cuenta y **su modo SSL, que no es igual en todas**:

| Zona | SSL | Hosts que apuntan a esta VPS |
|---|---|---|
| **`hilvanapp.com`** | **Full (strict)** | **`panel`**, `chauhinchazon`, `hilvapay`, `pay`, `paytest` |
| `hilvanapp.online` | Full | `gelatina`, `generador` |
| `hilvanapp.org` | Full | `ritual`, `landing`, `reset` (301) |
| `hilvanapp2.org` | Full | `reset`, `preview-reset`, `landing` |
| `infinixapp.com` | Full | `gatos`, `panel.infinixapp.com` |

El panel está en la única zona en **Full (strict)**, y puede estarlo porque su
certificado de origen sí corresponde: `/etc/caddy/certs/panel.pem` es un Origin
CA de Cloudflare con SAN `*.hilvanapp.com` + `hilvanapp.com`.

**Ojo con las otras zonas:** *todos* los certs de la máquina son ese mismo
`*.hilvanapp.com` (verificado con `openssl x509 -ext subjectAltName` sobre los
12 archivos de `/etc/caddy/certs/`), así que hosts como `ritual.hilvanapp.org` o
`gelatina.hilvanapp.online` andan solo porque sus zonas están en **Full** (no
strict), donde Cloudflare cifra hacia el origen pero **no valida el nombre del
certificado**. Pasar cualquiera de esas zonas a strict las tira al instante.
Este panel no se ve afectado.

El certificado de `panel.infinixapp.com` sí es distinto: `infinix.pem` es
**self-signed**. Esa zona depende de Full (no strict) igual que las otras.

### Las reglas de la zona `hilvanapp.com`

Son **por zona y matchean por path, no por hostname**, así que las mismas
reglas aplican al panel y a los funnels de la zona.

**Cache Rules**: la regla 1 hace bypass de cache en `/api/*`, `/admin*` y
`/pwa/*`. El panel entero está bajo `/` y `/api/`, y encima Caddy le pone
`Cache-Control: no-store, must-revalidate` con `defer`. Resultado verificado:
`cf-cache-status: DYNAMIC` en `/`. **El panel nunca se cachea**, que es lo que
se busca: tiene las ventas de todos los funnels adentro.

**WAF (Custom rules)**:

```
1. Eximir /api/ de chequeos de seguridad (webhooks firmados por HMAC/hottok)
   when: starts_with(path,"/api/")
   do:   Skip → bic, hot, securityLevel, uaBlock, zoneLockdown, rateLimit, waf

2. Bloquear Brasil excepto /api/
   when: ip.geoip.country eq "BR" and not starts_with(path,"/api/")
   do:   Block
```

La regla 1 es la que mantiene vivo el ingest y los webhooks de Shopify: el
Browser Integrity Check devolvía **403 error 1010** a clientes que no parecen
browser, y un 403 en el edge sobre `/api/ingest` o sobre un webhook de ventas es
data que se pierde sin error visible en ningún lado. Esos endpoints se
autentican por HMAC/ingest key, no por la protección de Cloudflare.

La regla 2 bloquea Brasil para el HTML: **si estás en Brasil, el panel no
abre.** No es un bug del panel.

### DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `panel` | la IP del origen | Proxied (naranja) |

Sin el naranja no hay WAF, no llega `cf-connecting-ip` **y ufw rechaza el
tráfico**, porque solo deja entrar a los rangos de Cloudflare. Un registro en
gris = panel caído.

### El panel no purga cache en el deploy

A diferencia de los funnels, `/srv/panel/shared/` **no tiene `deploy.env`**: no
hay `CF_ZONE_ID` ni `CF_API_TOKEN` acá, y `deploy.sh` no llama a la API de
Cloudflare. No hace falta: nada del panel es cacheable. Si alguna vez sospechás
del edge, purgá desde el dashboard (Caching → Configuration → Purge Everything)
o con el token de cualquier funnel de la zona.

---

## 3 · El ciclo completo

### 3.1 Local

```bash
docker compose up -d      # Postgres local. ESTO ES SOLO LOCAL: la VPS no tiene Docker
npm install
npm run db:migrate        # idempotente
npm run dev               # http://localhost:3005
```

### 3.2 Antes de commitear

```bash
npm test                  # vitest --run
npm run build             # que compile de verdad, no solo que pasen los tests
```

Correr el build en local no es opcional. `deploy.sh` lo corre en la VPS y si
falla ahí, perdiste el viaje y dejaste una entrada de error en `deploy.log`.

### 3.3 Commit y push

```bash
git add <archivos>        # por nombre, no `git add .`
git commit -m "…"
git push origin main
```

### 3.4 Deploy

```bash
ssh funnel-vps
/srv/panel/repo/deploy/deploy.sh
```

Si entraste como otro usuario con sudo: `sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh`.

**Nunca como root.** PM2 es por usuario: como root, el `pm2 startOrReload` crea
un `panel-3005` nuevo en el daemon de root en lugar de recargar el que está
sirviendo. El proceso viejo sigue con el código viejo y con el puerto tomado, el
nuevo cicla sin poder bindear, y el health check pasa porque contesta el viejo.
El deploy dice OK y no desplegó nada. Pasó de verdad el 2026-08-13 y costó una
caída; hoy el script tiene un guard que aborta en ese caso.

Para probar una rama sin mergear:

```bash
DEPLOY_BRANCH=mi-rama /srv/panel/repo/deploy/deploy.sh
```

Cuando termines, volvé a `main` con un deploy normal. Mientras esa rama esté
desplegada, un deploy sin `DEPLOY_BRANCH` la reemplaza por `main`.

### 3.5 Cambiar solo el env, sin rebuildear

```bash
nano /srv/panel/shared/.env.production      # chmod 600
/srv/panel/aplicar-env.sh
```

Ese script vive **fuera del repo** (igual que `set-password.sh`, para rotar
`DASHBOARD_PASSWORD`): copia el env a la release activa y recarga PM2 sin
rebuildear. Sirve para rotar una credencial rápido; para cualquier cambio que
toque código, deploy normal.

---

## 4 · Verificar

```bash
tail -40 /srv/panel/deploy.log
git -C /srv/panel/repo log --oneline -1        # el commit que quedó sirviendo
readlink -f /srv/panel/current                 # la release activa
pm2 status                                     # panel-3005 y panel-reglas online
curl -s -o /dev/null -w '%{http_code}\n' https://panel.hilvanapp.com/   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://panel.hilvanapp.com/login  # 307
```

El `/` da **200** y el `/login` da **307** (redirige a la app si ya hay
sesión, o a `/login` si no). El health check del deploy acepta 200 o 307 en `/`
justamente por eso.

```bash
# que no se cachee
curl -sI https://panel.hilvanapp.com/ | grep -iE 'cache-control|cf-cache-status'
# esperado: cache-control: no-store, must-revalidate · cf-cache-status: DYNAMIC

# la otra instancia del mismo repo sigue viva
curl -s -o /dev/null -w '%{http_code}\n' https://panel.infinixapp.com/   # 200
```

### Logs

```bash
# app (como deploy)
tail -f /var/log/pm2/panel-3005.out.log
tail -f /var/log/pm2/panel-3005.err.log
tail -f /var/log/pm2/panel-reglas.out.log

# crons (como deploy)
ls /var/log/panel/          # fx.log rollup.log ads.log db.log finance.log tareas.log
tail -f /var/log/panel/ads.log

# accesos (como root: el log es del usuario caddy)
ssh funnel-vps-root 'tail -f /var/log/caddy/panel.log'
```

---

## 5 · Qué hace `deploy.sh`, en orden

El orden es lo que da las garantías.

1. **Guards**: que no sea root, que exista `/srv/panel`, que exista
   `shared/.env.production`.
2. **`flock`**: un solo deploy a la vez.
3. **Código desde git**: `fetch --all --prune` + `reset --hard origin/main`. El
   fetch va *después* del flock a propósito: dos deploys simultáneos sobre el
   mismo working tree dejarían la release entre dos commits.
4. **Copia a `releases/<timestamp>/`** con rsync, excluyendo `node_modules`,
   `.next`, `.git`, `tasks`, `redesign-ui-tasks`, `.env*` y basura de Finder.
5. **Secretos**: instala `shared/.env.production` en la release con `chmod 600`.
6. **Guard de env vars.** Aborta antes del build si falta o está vacía
   cualquiera de estas **cinco**:

   ```
   DATABASE_URL   DASHBOARD_PASSWORD   NEXT_PUBLIC_SITE_URL
   SHOPIFY_WEBHOOK_SECRETS   META_ADS_TOKEN
   ```

   Las de Supabase (`SUPABASE_URL_*`, `SUPABASE_SERVICE_KEY_*`) **no** están en
   la lista a propósito: son las credenciales de los leads, opcionales, y sin
   ellas el panel anda y la sección muestra "no configurado".
7. **`npm ci` + `npm run build` + `npm test`.** Los tests corren contra
   `panel_test`, que se migra en el mismo paso: si una migración rompe los
   tests, el deploy se cae **antes** de tocar producción.
8. **Completa el standalone**: `next build` no copia `public/` ni
   `.next/static/` dentro de `.next/standalone/`. Además copia `scripts/` y
   `lib/`, y linkea el `node_modules` completo de la release, porque los crons
   corren con `tsx` desde `current`.
9. **Para `panel-reglas`** y **migra la base** (`db:migrate`). Si la migración
   falla, `current` sigue en la release anterior y el panel sigue sirviendo con
   el schema que conoce. El worker se para antes justamente para que no siga
   pegándole a Meta mientras el schema cambia.
10. **Corre el seed de usuarios** (`usuarios:seed`). Su fallo **no** aborta el
    deploy: si falla, el panel sigue funcionando por el fallback de
    `DASHBOARD_PASSWORD`, con una advertencia en el log.
11. **Verifica que el token de ads puede escribir.** Si no, aborta y el worker
    no se levanta, en lugar de dejarlo fallando en cada tick.
12. **Swap atómico** de `current` con `mv -Tf`.
13. **`pm2 reload panel-3005`** + health check en `/` (acepta 200 o 307, hasta
    20 intentos cada 2 s). Si no responde, vuelve solo a la release anterior.
14. **Recién ahí levanta `panel-reglas`**, con la release ya validada.
15. **Poda**: deja las 5 releases más nuevas, salteando la que está sirviendo.

### Estructura en la VPS

```
/srv/panel/
├── repo/                      clone de git (main). De acá sale cada build
├── releases/20260909234852/   una release = copia del repo + node_modules + build
├── current -> releases/<X>/.next/standalone      ← lo que apunta PM2
├── shared/
│   └── .env.production        env vars (600). LA fuente de verdad. NO hay deploy.env
├── backups/panel-YYYY-MM-DD.sql.gz    dumps diarios (los hace root, ver §7)
├── aplicar-env.sh             fuera del repo: env sin rebuild
├── set-password.sh            fuera del repo: rotar DASHBOARD_PASSWORD
├── deploy.log
└── repo.old, repo-backup-*.tar.gz     restos de la migración a git
```

`shared/` es `700 deploy:deploy` y el `.env.production` adentro es `600`. Hoy
tiene 14 variables, ninguna vacía: `DATABASE_URL`, `DASHBOARD_PASSWORD`,
`DASHBOARD_TZ`, `NEXT_PUBLIC_SITE_URL`, `SHOPIFY_WEBHOOK_SECRETS`, los tres
pares `SUPABASE_URL_*`/`SUPABASE_SERVICE_KEY_*` (chauhinchazon, reset,
gelatina), `META_ADS_TOKEN`, `OPENAI_API_KEY` y `OPENAI_MODEL`.

### El bloque de Caddy

Está en `deploy/Caddyfile.panel` y se pega a mano en `/etc/caddy/Caddyfile`.
**No usa el snippet `(funnel)`** a propósito: ese proxea a dos puertos, sirve
`/media/*` y pinnea `/admin` a una instancia, y nada de eso aplica acá.

```caddyfile
panel.hilvanapp.com {
	tls /etc/caddy/certs/panel.pem /etc/caddy/certs/panel.key
	encode zstd gzip
	header {
		defer
		Cache-Control "no-store, must-revalidate"
		X-Robots-Tag "noindex, nofollow"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
	reverse_proxy 127.0.0.1:3005 {
		header_up X-Real-IP {client_ip}
	}
	log { output file /var/log/caddy/panel.log { … } }
}
```

El `defer` **no es opcional**: sin él Caddy setea el header antes de correr el
proxy y la respuesta sale con **dos** `Cache-Control`.

Validar y recargar siempre en ese orden:

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

**`/etc/caddy/Caddyfile` es la fuente de verdad** y tiene bloques que no están
en ningún repo (`ritual`, `generador`, `gatos`, `panel.infinixapp.com`,
`hilvapay`, `pay`, `paytest`). El `provision.sh` de los repos de funnel copia su
propia versión ENCIMA: antes de correr uno, respaldar. Hay backups con timestamp
en `/etc/caddy/Caddyfile.bak-*`.

---

## 6 · Migraciones

Viven en `db/migrations/` y las corre `npm run db:migrate`, que es idempotente:
lleva la cuenta en la tabla `schema_migrations` (columnas `filename`,
`applied_at`).

El deploy migra **antes** de activar la release nueva, así que durante unos
segundos el código viejo corre contra el schema nuevo. **Escribí migraciones
compatibles hacia atrás**: agregar columnas nullable o con default, sí; borrar o
renombrar una columna que el código viejo todavía lee, no. Si necesitás borrar
algo, hacelo en dos deploys: primero el código que deja de usarla, después la
migración que la elimina.

Esto también es lo que hace que un rollback sea parcial: volver el código atrás
no deshace la migración.

### ⚠️ Hay una migración en producción que NO está en el repo

Verificado el 2026-09-13:

| | migraciones aplicadas |
|---|---|
| `db/migrations/` del repo | 31 archivos (última: `031_tareas.sql`) |
| base `panel` (producción) | **32** |
| base `panel_test` | 31 |
| base `panel_infinix` | 31 |

La de más en producción es **`029_funnel_gelatina.sql`**, que da de alta el
funnel `gelatina` (22 pasos y 8 etapas). El archivo vive en el repo de
`gelatina-fit` (`tasks/_migracion-panel-029.sql`) y se aplicó a mano contra la
base `panel`, sin copiarlo acá. Además colisiona de número con
`029_insights_ia.sql`, que sí está en el repo.

Dos consecuencias:

- **Un clon limpio + `npm run db:migrate` no crea el funnel `gelatina`.** Si
  alguna vez hay que reconstruir la base desde el repo, ese funnel falta y su
  ingest devuelve 401.
- `panel_test` (donde corren los tests del deploy) no lo tiene, así que ningún
  test lo cubre.

Lo correcto es copiar ese SQL a `db/migrations/` con un número libre (el
próximo es **032**) y aplicarlo: al ser idempotente, en producción no va a
insertar nada de nuevo, solo va a registrar la fila que falta. **No está hecho.**

---

## 7 · Los crons y los backups

Están en **dos crontabs distintos**, y esa división importa a la hora de
buscarlos.

### `crontab -l` como `deploy` — 17 líneas

Nueve son de este panel, todas con el patrón
`cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/<x>.ts >> /var/log/panel/<y>.log 2>&1`:

| Cuándo | Script | Log |
|---|---|---|
| `10 5 * * *` | `fetch-fx.ts` | `fx.log` |
| `*/10 * * * *` | `rollup.ts --days=3` | `rollup.log` |
| `25 5 * * *` | `rollup.ts --days=35` | `rollup.log` |
| `0 4 1 * *` | `ensure-partitions.ts` | `db.log` |
| `7 * * * *` | `sync-ads.ts` | `ads.log` |
| `*/15 * * * *` | `sync-ads-jerarquia.ts` | `ads.log` |
| `*/30 * * * *` | `run-ad-rules.ts --health` | `ads.log` |
| `40 5 * * *` | `finance-scheduled-payments.ts` | `finance.log` |
| `50 5 * * *` | `archivar-tareas.ts` | `tareas.log` |

Las otras ocho son de `/srv/panel-infinix` (cinco) y de `/srv/hilvapay` (tres).
**Un solo crontab para todo**: al editarlo, no borres líneas ajenas.

El `--env-file` de Node no es decorativo: `tsx` **no** lee `.env` solo.

**`generar-insights.ts` está en `deploy/cron.panel` pero NO está instalado.** No
existe `/var/log/panel/ia.log`. `OPENAI_API_KEY` y `OPENAI_MODEL` sí están
cargadas en el env, así que la línea funcionaría; simplemente nunca se pegó al
crontab. Si querés los insights diarios:

```bash
ssh funnel-vps
crontab -l > /tmp/cron.actual          # respaldá primero
crontab -e                             # agregá la línea de generar-insights de deploy/cron.panel
crontab -l | grep insights             # confirmá
```

### `crontab -l` como `root` — 2 líneas

Los backups de la base **no están en el crontab de `deploy`**, están en el de
`root`, porque necesitan `sudo -u postgres`:

```
30 4 * * * sudo -u postgres pg_dump panel | gzip > /srv/panel/backups/panel-$(date +\%F).sql.gz
35 4 * * * find /srv/panel/backups -name 'panel-*.sql.gz' -mtime +14 -delete
```

Verificado: hay dumps al día en `/srv/panel/backups/` (~32 MB cada uno,
propiedad de `root`), con retención de 14 días. Para chequearlo rápido:

```bash
ssh funnel-vps-root 'ls -lt /srv/panel/backups/ | head -5'
```

**No hay backup de `panel_infinix`.** Si esa instancia empieza a tener
historial, hace falta una línea equivalente.

---

## 8 · El worker de reglas de ads

`panel-reglas` ejecuta el motor de reglas de Meta Ads: **pausa y reactiva
campañas**, o sea que gasta plata real.

- En **hilvanapp** corre, y el deploy lo para antes de migrar y lo levanta
  recién después de que el health check de la app pasó.
- En **infinix no está levantado a propósito**: levantarlo en una instancia sin
  reglas revisadas y con un token que puede apuntar a otra cuenta publicitaria
  es riesgo sin contrapartida. El embudo, las ventas y el paso a paso no
  dependen de él. Si algún día se activa, va con nombre propio
  (`panel-infinix-reglas`) y después de revisar `ad_rules` en la base.

Ante un deploy dudoso, el lado seguro es que **no** corra:

```bash
pm2 stop panel-reglas
```

---

## 9 · Rollback

**El panel no tiene `rollback.sh`** como los funnels. Tiene el rollback
automático de `deploy.sh` (si el health check falla), pero para "el deploy salió
bien y la release está mal" es a mano:

```bash
ssh funnel-vps

# 1. Ver qué releases hay y cuál está activa
ls -1t /srv/panel/releases/
readlink -f /srv/panel/current

# 2. Elegir una que tenga el build hecho
ls /srv/panel/releases/<stamp>/.next/standalone/server.js

# 3. Swap atómico (mv -T, no ln -sfn sobre current: eso deja una ventana sin symlink)
ln -sfn /srv/panel/releases/<stamp>/.next/standalone /srv/panel/current.tmp
mv -Tf /srv/panel/current.tmp /srv/panel/current

# 4. Recargar la app. El worker se deja PARADO: es el que gasta plata
pm2 reload panel-3005 --update-env
pm2 stop panel-reglas

# 5. Verificar
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/
```

No corras `pm2 save` hasta confirmar que quedó sano: si guardás un estado roto,
vuelve igual en el próximo reboot.

Y de nuevo: **esto no deshace las migraciones.** Si el problema es de schema,
`docs/runbook.md` §5 tiene el procedimiento para restaurar un backup de
`/srv/panel/backups/`.

### Reboot

PM2 resucita los procesos desde `/home/deploy/.pm2/dump.pm2` vía el unit
`pm2-deploy`; Caddy, Postgres, ufw y fail2ban arrancan con el sistema.
`Automatic-Reboot` de unattended-upgrades está **desactivado**: el server no se
reinicia solo. Lo único que rompe la resurrección es olvidarse de `pm2 save`
después de cambiar los procesos.

---

## 10 · Lo que nunca va al repo

- **`.env` / `.env.production`** — los secretos viven solo en
  `/srv/panel/shared/.env.production` con `chmod 600`. Ahí están el
  `DATABASE_URL`, el token de Meta Ads, la key de OpenAI y las tres claves de
  service role de Supabase.
- **`orders_export*.csv` y `*_export_*.csv`** — exports de Shopify con datos
  personales de clientes (nombre, email, teléfono, direcciones). Había uno en la
  raíz del proyecto con 48.614 filas. Un archivo así en un repo, aunque sea
  privado, convierte cada clon (la VPS, cada máquina de desarrollo) en una base
  de datos de clientes sin control. Si necesitás analizar uno, dejalo fuera del
  proyecto.

El único archivo de entorno que sí va es `.env.example`, con placeholders.

---

## 11 · Operación diaria

Todo desde `/srv/panel/current` en la VPS, como `deploy`. Los scripts corren con
`tsx`, que **no** lee `.env` solo: el `--env-file` de Node inyecta las
variables.

```bash
cd /srv/panel/current

npm run ads:token        # ¿el token de Meta puede escribir?
npm run fx:backfill      # aplicar cotizaciones a órdenes que quedaron sin ella
npm run rollup           # recalcular el Resumen
npm run usuarios:seed    # idempotente: crea al admin si no existe, no toca los que ya están
```

Para `psql`, como `root`:

```bash
ssh funnel-vps-root
sudo -u postgres psql -d panel        # producción
sudo -u postgres psql -l | grep panel # panel, panel_test, panel_infinix, panel_infinix_test
```

Los diagnósticos largos y las consultas útiles están en `docs/runbook.md`; lo
específico de anuncios, en `docs/runbook-anuncios.md`.

### Usuarios del panel

El módulo de usuarios reemplazó la contraseña compartida por login por usuario,
con permisos por pestaña y un tablero de tareas. Dos cosas que sobreviven de su
deploy:

- **El seed crea cada usuario con la clave `123456` y
  `debe_cambiar_clave = true`.** En ese estado la sesión no sirve para nada
  salvo cambiar la clave (redirige a `/cambiar-clave`), pero **cualquiera que
  sepa el nombre de usuario entra**. Si sembrás un usuario nuevo, entrá el mismo
  día y cambiale la clave.
- **`DASHBOARD_PASSWORD` sigue siendo el fallback.** Si el seed nunca corrió en
  una instancia, esa instancia entra con la contraseña compartida y **no se
  rompe, pero no tiene usuarios** — es fácil no darse cuenta porque nada falla.

Estado verificado el 2026-09-13 en la base `panel`: dos usuarios (`lucho`
admin, `nahuel`), los dos activos y **los dos con `debe_cambiar_clave = false`**
(o sea, ya cambiaron la clave inicial).

Para mirarlo:

```bash
ssh funnel-vps-root
sudo -u postgres psql -d panel -c \
  "SELECT usuario, es_admin, debe_cambiar_clave, activo FROM usuarios ORDER BY id"
```

Si algún deploy le devuelve la clave `123456` a alguien que ya la cambió, el
seed dejó de ser idempotente: es lo más caro que puede salir mal de ese módulo.

**Infinix corre su seed a mano**, porque su `deploy.sh` (fuera del repo) no lo
incluye:

```bash
sudo -u deploy bash /srv/panel-infinix/deploy.sh
cd /srv/panel-infinix/current
PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan \
  /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/seed-usuarios.ts
```

El cron de archivado de tareas de infinix también se agregó a mano y ya está
instalado (`50 5 * * *` sobre `/srv/panel-infinix/current`).

---

## 12 · Qué se verificó el 2026-09-13

Para que se sepa qué es dato duro y qué es historia:

- `pm2 status` (`panel-3005` y `panel-reglas` online),
  `readlink -f /srv/panel/current` (release `20260909234852`),
  `git -C /srv/panel/repo remote get-url origin`
  (`git@github-panel:drasticcurl/dashboard-admin.git`, rama `main`).
- `crontab -l` de `deploy` (17 líneas) y de `root` (2 líneas), más
  `ls -lt /srv/panel/backups/` y la ausencia de `/var/log/panel/ia.log`.
- Postgres: `select version()` (16.15), `show listen_addresses` (localhost), la
  lista de bases, `select filename from schema_migrations` en `panel` (32),
  `panel_test` (31) y `panel_infinix` (31), los cuatro funnels de `panel` y los
  dos usuarios.
- `/etc/caddy/Caddyfile`: el bloque de `panel.hilvanapp.com` y los otros 14
  bloques de sitio. `openssl x509 -ext subjectAltName` sobre los 12 certs de
  `/etc/caddy/certs/`.
- `ufw status`, `sshd` sin password auth, versiones (Node 20.20.2, npm 10.8.2,
  PM2 7.0.3, Caddy 2.11.4).
- API de Cloudflare: las 5 zonas, su `settings/ssl`, sus `dns_records` y sus
  `rulesets` de cache y firewall.
- HTTP en vivo: `panel.hilvanapp.com/` da 200 con
  `cache-control: no-store, must-revalidate` y `cf-cache-status: DYNAMIC`;
  `/login` da 307; `panel.infinixapp.com/` da 200.
- Los nombres (no los valores) de las 14 variables de
  `/srv/panel/shared/.env.production`.

Lo que **no** se verificó: si los números que muestra el panel son correctos, ni
el estado de las reglas de ads. Eso se mira en el panel y en Meta.

Se corrigió de la versión anterior de este documento: la referencia a un
`../DEPLOYS.md` que **no existe** (nunca se creó), la lista de crons (eran
"8 tareas" y hoy son 9 en el crontab de `deploy` más 2 en el de `root`), y el
orden de `deploy.sh`, que ahora incluye el seed de usuarios y la verificación
del token de ads.
