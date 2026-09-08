# Cómo hacer un cambio en el panel y llevarlo a producción

Este documento es el paso a paso del día a día. La infraestructura general
está en `../DEPLOYS.md`, y la operación de la base y los diagnósticos en
`docs/runbook.md`.

- **Repo:** `drasticcurl/dashboard-admin` (privado)
- **En la VPS:** `/srv/panel/`
- **Dominio:** `panel.hilvanapp.com` → `127.0.0.1:3005`
- **PM2:** `panel-3005` (la app) y `panel-reglas` (worker de reglas de ads)
- **Rama de producción:** `main`
- **Base:** PostgreSQL 16 en `127.0.0.1:5432`, base `panel`

---

## El ciclo completo

### 1. Desarrollo local

```bash
docker compose up -d      # Postgres local (esto es SOLO local: la VPS no tiene Docker)
npm install
npm run db:migrate        # idempotente
npm run dev               # http://localhost:3005
```

### 2. Antes de commitear

```bash
npm test                  # vitest --run
npm run build             # que compile de verdad, no solo que pasen los tests
```

Correr el build en local no es opcional. `deploy.sh` lo corre en la VPS y si
falla ahí, perdiste el viaje y dejaste una entrada de error en `deploy.log`.

### 3. Commit y push

```bash
git add <archivos>        # preferí archivos por nombre, no `git add .`
git commit -m "…"
git push origin main
```

### 4. Deploy

```bash
ssh funnel-vps
sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
```

Si ya entraste como `deploy` (que es lo que hace `ssh funnel-vps`), alcanza:

```bash
/srv/panel/repo/deploy/deploy.sh
```

**Nunca como root.** PM2 es por usuario: como root, el `pm2 startOrReload`
crea un `panel-3005` nuevo en el daemon de root en lugar de recargar el que
está sirviendo. El proceso viejo sigue con el código viejo y con el puerto
tomado, el nuevo cicla sin poder bindear, y el health check pasa porque
contesta el viejo. El deploy dice OK y no desplegó nada. El script tiene un
guard que aborta en ese caso.

### 5. Verificar

```bash
tail -40 /srv/panel/deploy.log
git -C /srv/panel/repo log --oneline -1        # el commit que quedó sirviendo
curl -s -o /dev/null -w '%{http_code}\n' https://panel.hilvanapp.com/   # 200
pm2 status                                     # panel-3005 y panel-reglas online
```

---

## Probar una rama antes de mergear

```bash
sudo -u deploy DEPLOY_BRANCH=mi-rama bash /srv/panel/repo/deploy/deploy.sh
```

Cuando termines, volvé a `main` con un deploy normal. Ojo: mientras esa rama
esté desplegada, un deploy sin `DEPLOY_BRANCH` la reemplaza por `main`.

---

## Qué hace `deploy.sh`, en orden

Vale conocerlo porque el orden es lo que da las garantías:

1. **Guards**: que no sea root, que exista `/srv/panel`, que exista
   `shared/.env.production`.
2. **`flock`**: un solo deploy a la vez.
3. **Código desde git**: `fetch --all --prune` + `reset --hard origin/main`.
   El fetch va *después* del flock a propósito: dos deploys simultáneos sobre
   el mismo working tree dejarían la release entre dos commits.
4. **Copia a `releases/<timestamp>/`** con rsync, excluyendo `node_modules`,
   `.next`, `.git`, `tasks`, `redesign-ui-tasks`, `.env*` y basura de Finder.
5. **Secretos**: instala `shared/.env.production` en la release con `chmod 600`.
6. **Guard de env vars.** Aborta antes del build si falta o está vacía
   cualquiera de estas cinco:

   ```
   DATABASE_URL   DASHBOARD_PASSWORD   NEXT_PUBLIC_SITE_URL
   SHOPIFY_WEBHOOK_SECRETS   META_ADS_TOKEN
   ```

   Las de Supabase (`SUPABASE_URL_*`, `SUPABASE_SERVICE_KEY_*`) **no** están en
   la lista a propósito: son opcionales, y sin ellas el panel anda y la sección
   de leads muestra "no configurado".
7. **`npm ci` + `npm run build` + `npm test`.** Los tests corren contra
   `panel_test`, que se migra en el mismo paso: si una migración rompe los
   tests, el deploy se cae **antes** de tocar producción.
8. **Completa el standalone**: `next build` no copia `public/` ni
   `.next/static/` dentro de `.next/standalone/`. Además copia `scripts/` y
   `lib/`, y linkea el `node_modules` completo de la release, porque los crons
   corren con `tsx` desde `current`.
9. **Para `panel-reglas`** y **migra la base** (`npm run db:migrate`). Si la
   migración falla, `current` sigue en la release anterior y el panel sigue
   sirviendo con el schema que conoce.
10. **Verifica que el token de ads puede escribir.** Si no, aborta y el worker
    no se levanta, en lugar de dejarlo fallando en cada tick.
11. **Swap atómico** de `current` con `mv -Tf`.
12. **`pm2 reload panel-3005`** + health check en `/` (acepta 200 o 307, hasta
    20 intentos cada 2 s). Si no responde, vuelve solo a la release anterior.
13. **Recién ahí levanta `panel-reglas`**, con la release ya validada.
14. **Poda**: deja las 5 releases más nuevas, salteando la que está sirviendo.

---

## Cambios que necesitan una migración

Las migraciones viven en `db/migrations/` y las corre `npm run db:migrate`
(idempotente: corrida dos veces no toca nada).

El deploy migra **antes** de activar la release nueva, así que durante unos
segundos el código viejo corre contra el schema nuevo. **Escribí migraciones
compatibles hacia atrás**: agregar columnas nullable o con default, sí; borrar
o renombrar una columna que el código viejo todavía lee, no. Si necesitás
borrar algo, hacelo en dos deploys: primero el código que deja de usarla,
después la migración que la elimina.

Esto también es lo que hace que un rollback sea parcial: volver el código atrás
no deshace la migración.

---

## Rollback

**El panel no tiene `rollback.sh`** como los funnels. Tiene el rollback
automático de `deploy.sh` (si el health check falla), pero para "el deploy
salió bien y la release está mal" es a mano:

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

# 4. Recargar la app. El worker se deja PARADO: es el que gasta plata, y ante
#    un deploy dudoso el lado seguro es que no corra.
pm2 reload panel-3005 --update-env
pm2 stop panel-reglas

# 5. Verificar
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/
```

No corras `pm2 save` hasta confirmar que quedó sano: si guardás un estado roto,
vuelve igual en el próximo reboot.

Y de nuevo: **esto no deshace las migraciones.** Si el problema es de schema,
revisá `docs/runbook.md` §5 para restaurar un backup.

---

## Lo que nunca va al repo

El `.gitignore` ya lo cubre, pero para que quede dicho:

- **`.env` / `.env.production`** — los secretos viven solo en
  `/srv/panel/shared/.env.production` con `chmod 600`.
- **`orders_export*.csv` y `*_export_*.csv`** — exports de Shopify con datos
  personales de clientes (nombre, email, teléfono, direcciones). Había uno en
  la raíz del proyecto con 48.614 filas. Un archivo así en un repo, aunque sea
  privado, convierte cada clon (la VPS, cada máquina de desarrollo) en una base
  de datos de clientes sin control. Si necesitás analizar uno, dejalo fuera del
  proyecto.

El único archivo de entorno que sí va es `.env.example`, que tiene solo
placeholders.

---

## Comandos de operación más usados

Todos desde `/srv/panel/current` en la VPS, como `deploy`. Los scripts corren
con `tsx`, que **no** lee `.env` solo: el `--env-file` de Node inyecta las
variables.

```bash
cd /srv/panel/current

npm run ads:token        # ¿el token de Meta puede escribir?
npm run fx:backfill      # aplicar cotizaciones a órdenes que quedaron sin ella
npm run rollup           # recalcular el Resumen
```

Para `psql`, primero definí `PGURL` como está en `docs/runbook.md`.

---

## Deploy del módulo de usuarios y tareas (login por usuario + kanban)

Este módulo le da identidad al panel: cada persona entra con su usuario y su
clave en vez de la contraseña compartida, un admin decide qué pestañas ve cada
uno, y hay un tablero de tareas. Su deploy tiene tres cosas que hay que saber de
antemano.

### ⚠️ SE CORTAN TODAS LAS SESIONES VIVAS EN EL DEPLOY

El formato de la cookie cambió: el token viejo tiene 2 campos y el parser nuevo
lo rechaza. **Todo el mundo vuelve a entrar** en el primer request después del
deploy. No es un bug y no hay que "arreglarlo": es el fallo seguro de cambiar el
esquema de la cookie a uno que lleva identidad firmada.

### 🔴 LAS CLAVES INICIALES SON `123456` Y HAY QUE CAMBIARLAS **EL MISMO DÍA**

El seed crea cada usuario con la clave **`123456`** y `debe_cambiar_clave = true`.
Mientras nadie la cambie, **cualquiera que sepa el nombre de usuario entra**. La
sesión en ese estado no sirve para nada salvo cambiar la clave (redirige a
`/cambiar-clave`), pero la ventana de exposición es real: **entrá el mismo día
del deploy con cada usuario y cambiá la clave. No "cuando se pueda".**

### Secuencia de hilvanapp

```bash
sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
# el deploy ya corre, en orden:  db:migrate → usuarios:seed → health check
# el seed crea a 'lucho' (admin) con clave 123456 si no existe; si ya existe NO lo toca.

# después, desde el browser: entrar como lucho / 123456 y cambiar la clave EN EL ACTO.
```

El cron de archivado de tareas queda instalado solo: la línea está en
`deploy/cron.panel` y la instala el deploy de hilvanapp.

### Secuencia de infinix — ES MANUAL, y es lo más importante de esta sección

`/srv/panel-infinix/deploy.sh` vive **FUERA del repo** (está afuera porque el
repo es compartido y su `git reset --hard` borraría un archivo propio de la
instancia). Ninguna task del módulo lo pudo editar, así que **el seed y el cron
de esa instancia se corren a mano**:

```bash
sudo -u deploy bash /srv/panel-infinix/deploy.sh     # ese deploy.sh NO tiene el seed
cd /srv/panel-infinix/current

# 1. Sembrar el admin de infinix (usuario propio: Ivan, no lucho)
PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan \
  /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/seed-usuarios.ts

# 2. Agregar la línea del cron de archivado al crontab de esa instancia, A MANO
#    (misma que deploy/cron.panel pero con el path de infinix):
#    50 5 * * * cd /srv/panel-infinix/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/archivar-tareas.ts >> /var/log/panel-infinix/tareas.log 2>&1
```

**Mientras el seed no corra en infinix, esa instancia entra con
`DASHBOARD_PASSWORD` por el fallback de D10** — o sea que **no se rompe, pero no
tiene usuarios**, y es fácil no darse cuenta porque nada falla. Después de
sembrar, entrá como `ivan / 123456` y cambiá la clave el mismo día.

### Cómo volver atrás

Las migraciones (030 y 031) son **aditivas**: crean cinco tablas nuevas y no
tocan nada existente. Revertir el código deja esas tablas ahí sin lectores y el
panel vuelve a la contraseña compartida (`DASHBOARD_PASSWORD`) solo, por el
fallback. **NO hay que borrar las tablas para revertir**, y borrarlas se
llevaría todas las tareas cargadas. Un rollback de código es suficiente.

### Qué mirar después

```bash
# con PGURL definido como en docs/runbook.md:
psql "$PGURL" -tAc "SELECT usuario, es_admin, debe_cambiar_clave, activo FROM usuarios ORDER BY id"
# esperado: los usuarios de la instancia, y debe_cambiar_clave en 'f' (false)
#           después de que cada uno entró y cambió su clave.
```

Si algún deploy le devuelve la clave `123456` a alguien que ya la cambió, el
seed dejó de ser idempotente: es lo más caro que puede salir mal de este módulo,
y va también en la sección de abajo.

---

## Cosas que ya pasaron y no conviene repetir

- **Correr `deploy.sh` como root** (2026-08-13, costó una caída). Ver arriba.
- **Documentar la base como un contenedor Docker.** Los runbooks tenían 14
  comandos `docker exec panel-db-1 psql …` que fallaban con
  `command not found`, porque en la VPS no hay Docker: Postgres es el paquete
  de Ubuntu. Corregido el 2026-08-14. El `docker-compose.yml` del repo es solo
  para desarrollo local.
- **Deployar por rsync.** Hasta 2026-08 este proyecto no tenía git y se subía
  con `rsync`: en el server no había forma de saber qué versión estaba
  corriendo. Si por algo necesitás volver a ese modo (GitHub caído, bring-up):

  ```bash
  DEPLOY_SOURCE=local sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
  ```

  No es el modo de régimen: con `local` el script usa lo que haya en el
  directorio, sin saber de qué commit viene.
