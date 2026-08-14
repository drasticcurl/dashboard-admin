# T01 — Fundación: proyecto, Postgres, schema y librerías base

- **Depende de:** nada.
- **Bloquea:** absolutamente todo. Ningún otro task puede arrancar antes de que este termine y
  compile.
- **Corre sola.** No paralelizar con nada.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** los de la fila T01 de §8 del plan.

Leé `00-PLAN.md` completo antes de escribir una línea. El §3 es el schema canónico: se copia tal
cual, no se mejora.

---

## 1. Objetivo

Dejar el proyecto en un estado en el que:

- `npm run build` y `npx tsc --noEmit` pasan,
- `docker compose up -d` levanta un Postgres 16 con volumen propio,
- `npm run db:migrate` crea todo el schema y los seeds, y es idempotente,
- las librerías compartidas (`lib/db.ts`, `lib/day.ts`, `lib/fx.ts`, `lib/funnels.ts`,
  `lib/types.ts`) existen con su API definitiva, porque **cinco tasks en paralelo van a importarlas
  y ninguno puede modificarlas**.

Este task no escribe ninguna página ni ningún endpoint.

## 2. Scaffolding

Next.js 14 App Router, TypeScript, Tailwind. **Las versiones se copian de
`~/Desktop/funnel/testfunnel/package.json`** para garantizar que la app corre en el Node 20.20.2 de
la VPS con la misma combinación ya probada. `package.json` final:

```json
{
  "name": "panel-dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3005",
    "build": "next build",
    "start": "next start -p 3005",
    "lint": "next lint",
    "test": "vitest --run",
    "test:watch": "vitest",
    "db:migrate": "tsx scripts/migrate.ts",
    "db:partitions": "tsx scripts/ensure-partitions.ts",
    "db:ingest-key": "tsx scripts/set-ingest-key.ts",
    "fx:fetch": "tsx scripts/fetch-fx.ts",
    "fx:backfill": "tsx scripts/backfill-fx.ts",
    "rollup": "tsx scripts/rollup.ts",
    "import:purchases": "tsx scripts/import-purchases.ts"
  },
  "dependencies": {
    "next": "14.2.5",
    "pg": "^8.13.1",
    "react": "^18",
    "react-dom": "^18",
    "recharts": "^2.15.4",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/pg": "^8.11.10",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10.0.1",
    "eslint": "^8",
    "eslint-config-next": "14.2.5",
    "postcss": "^8",
    "tailwindcss": "^3.4.1",
    "tsx": "^4.19.2",
    "typescript": "^5",
    "vitest": "^2.1.8"
  }
}
```

Los scripts de `fx:*`, `rollup` e `import:purchases` apuntan a archivos que crean T03, T08 y T12.
**Declaralos igual**: es la única forma de que ningún otro task tenga que tocar `package.json` (§8
del plan). Que un script apunte a un archivo que todavía no existe no rompe el build.

Si `npm install` resuelve una versión distinta de `pg`, `@types/pg` o `tsx`, dejá la que resolvió y
anotá cuál quedó en el README. No inventes números de versión.

`next.config.mjs`: `output: 'standalone'` (lo necesita el deploy con PM2), `reactStrictMode: true`,
y `poweredByHeader: false`.

`tsconfig.json`: copiá el de `testfunnel` y dejá el alias `"@/*": ["./*"]`.

`.gitignore`: `node_modules`, `.next`, `.env*` menos `.env.example`, `*.log`, `tsconfig.tsbuildinfo`.

`app/globals.css`: las directivas de Tailwind y nada más. El tema visual lo define T05; no lo
adelantes.

`app/layout.tsx` **no lo escribe este task** (es de T05). Para que `npm run build` pase, creá un
`app/layout.tsx` mínimo de 10 líneas con `<html lang="es">`, el import de `globals.css` y
`export const metadata = { title: 'Panel', robots: 'noindex, nofollow' }`. Dejá el comentario
`// T05 reemplaza este archivo completo.` arriba.

`vitest.config.ts`: copialo de `testfunnel` pero **sin** el entorno jsdom ni los setup de
testing-library (este proyecto testea funciones puras y SQL, no componentes). `environment: 'node'`.

## 3. `docker-compose.yml`

Un proyecto de Compose propio. Tomá como modelo `~/Desktop/funnel/finanzas/docker-compose.yml`, que
ya corre en esta misma VPS, y **quedate con sus tres decisiones de seguridad**: nombre de proyecto
propio para aislar recursos, sin puertos públicos, y límite de logs.

```yaml
name: panel

services:
  db:
    image: postgres:16
    restart: unless-stopped
    # El prefijo 127.0.0.1 es obligatorio. Sin él Docker publica en 0.0.0.0 y
    # escribe sus reglas de iptables POR DELANTE de ufw: la base quedaría
    # abierta a internet con la password como única defensa.
    ports:
      - "127.0.0.1:${DB_PORT:-5432}:5432"
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      TZ: ${TZ:-America/Argentina/Buenos_Aires}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  pgdata:
```

`DB_PORT` es variable porque en la VPS hay que verificar con `ss -tlnp | grep 5432` antes de
instalar: si está ocupado, se usa 5433. El volumen real se va a llamar `panel_pgdata` por el
`name: panel`, así que no puede colisionar con el `finanzas_pgdata` que ya existe.

**La app no va en Compose** (D17): corre en PM2, igual que los funnels, y llega a la base por
`127.0.0.1`.

`.env.example` con todo comentado:

```bash
# ── Base de datos ────────────────────────────────────────────────
POSTGRES_USER=panel
POSTGRES_PASSWORD=            # openssl rand -base64 32
POSTGRES_DB=panel
DB_PORT=5432                  # 5433 si el 5432 del host está ocupado
DATABASE_URL=postgres://panel:PASSWORD@127.0.0.1:5432/panel

# ── App ──────────────────────────────────────────────────────────
DASHBOARD_PASSWORD=           # openssl rand -base64 24 · min 24 caracteres
DASHBOARD_TZ=America/Argentina/Buenos_Aires
NEXT_PUBLIC_SITE_URL=https://panel.hilvanapp.com

# ── Webhooks ─────────────────────────────────────────────────────
# Los MISMOS secrets que ya están en el env de cada funnel: las suscripciones
# creadas desde el admin de la tienda firman con el secret de la tienda.
SHOPIFY_WEBHOOK_SECRETS=

# ── Leads (solo lectura, por funnel) ─────────────────────────────
SUPABASE_URL_CHAUHINCHAZON=
SUPABASE_SERVICE_KEY_CHAUHINCHAZON=
SUPABASE_URL_RESET=
SUPABASE_SERVICE_KEY_RESET=
```

Las ingest keys **no van en el env del dashboard**: viven en el env de cada funnel y acá solo se
guarda su hash en `funnels.ingest_key_hash`.

## 4. Migraciones

`db/migrations/`, numeradas y aplicadas en orden alfabético:

| Archivo | Contenido |
|---|---|
| `001_catalogo.sql` | `funnels`, `funnel_steps` (§3.1, §3.2 del plan) |
| `002_sessions.sql` | `sessions` con sus 5 índices (§3.3) |
| `003_events.sql` | `events` particionada + 12 particiones mensuales + `events_default` (§3.4) |
| `004_orders.sql` | `orders`, `order_items`, `product_map`, `shop_map` (§3.5, §3.6) |
| `005_fx.sql` | `fx_rates` (§3.7) |
| `006_metrics.sql` | `daily_metrics` (§3.8) |
| `007_observabilidad.sql` | `ingest_errors`, `webhook_events`, `settings` (§3.9, §3.10) |
| `008_ad_spend.sql` | `ad_spend` vacía (§3.11) |
| `009_seed_funnels.sql` | los dos funnels y sus 22 + 27 pasos (§3.12) |
| `010_seed_settings.sql` | `fx_source='oficial'`, `default_currency_view='EUR'`, `retention_days_events=180` |

**Atajo que ya está hecho y verificado:** `tasks/_schema-canonico.sql` es el DDL completo del §3, en
un solo archivo, **ya ejecutado contra un PostgreSQL 16 real** (corre limpio y es idempotente: dos
corridas seguidas salen 0). Partilo en los 10 archivos de la tabla de arriba en vez de tipearlo de
nuevo. Y `tasks/_verificacion-logica.sql` prueba las 11 afirmaciones del plan de las que dependen T02,
T06, T07 y T08 (semántica de `LEAST`/`GREATEST` con NULL, la no-sobrescritura de la atribución, la
suma acumulada inversa del embudo, el ruteo de particiones, el día local por TZ). **Corrélo** después
de migrar: si algo no da lo que dice el `\echo`, el problema está en tu migración, no en el plan.

Reglas para todos los archivos:

- Copiá el DDL del §3 del plan **literal**. Es el contrato que van a asumir cinco tasks en paralelo.
- Cada `CREATE` va con `IF NOT EXISTS` y cada seed con `ON CONFLICT DO NOTHING` (o
  `DO UPDATE` donde tenga sentido), para que el runner sea idempotente incluso si alguien corrió una
  migración a mano.
- Arriba de cada archivo, un comentario de 3 a 6 líneas explicando **por qué** está así: sobre todo
  los centinelas (`'(directo)'`, `'*'`, `funnel_id NULL`) y por qué la PK de `events` incluye
  `occurred_at`. Los comentarios de las migraciones de los funnels son el modelo de estilo: explican
  el bug que la decisión evita, no lo que el SQL ya dice.
- **Nada de `DISABLE ROW LEVEL SECURITY`.** Eso era necesario en Supabase; acá la base no está
  expuesta y el único cliente es la app.

Particiones de `events`: generalas con un `DO $$ … $$` que itere 12 meses desde
`date_trunc('month', now())`, y creá además la `DEFAULT`:

```sql
CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;
```

Sin la `DEFAULT`, un evento con una fecha fuera de rango hace fallar el `INSERT` y se pierde
(contra D20).

## 5. Seeds de los pasos — verificar contra el código, no confiar en la tabla

Las dos listas del §3.12 del plan son el orden real al momento de escribirlo, **pero el código pudo
cambiar**. Antes de escribir `009_seed_funnels.sql`, corré esto y comparalo con la tabla:

```bash
grep -n "id: '" ~/Desktop/funnel/testfunnel/lib/quiz-v2/data.ts | head -40
grep -n "id: '" ~/Desktop/funnel/reset-app/lib/quiz-v2/data.ts  | head -40
```

El array que importa es `slidesV3` (en `testfunnel` hay además `slidesV3Latam` en
`data-latam.ts`, con **los mismos ids en el mismo orden**: es solo copy distinto, así que comparte
catálogo y se distingue por `variant`).

Si el orden o los ids no coinciden con el §3.12, **gana el código** y se anota la diferencia en §10
del plan. Un catálogo desalineado hace que el embudo muestre el nombre de una pregunta en la fila de
otra, que es peor que no mostrar nada.

Cantidades esperadas: `chauhinchazon` 22 pasos (0-21), `reset` 27 pasos (0-26).

`funnels` se seedea con `ingest_key_hash` en un placeholder imposible de matchear
(`'PENDING_SET_INGEST_KEY_CHAUHINCHAZON'`), no con un hash real y no con string vacío: así, si
alguien despliega sin correr `db:ingest-key`, el ingest devuelve 401 en lugar de aceptar cualquier
cosa.

## 6. `lib/db.ts`

Pool de `pg` memoizado, como el patrón de `lib/supabase.ts` de los funnels pero **sin el modo
degradado**: acá, si no hay base, no hay nada que hacer y tiene que fallar fuerte y temprano.

```ts
import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool { /* memoiza; throw si falta DATABASE_URL */ }

/** Query de una sola vez. Los parámetros SIEMPRE van como $1, $2 — nunca interpolados. */
export async function q<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;

/** Una sola fila o null. */
export async function q1<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;

/** Transacción: BEGIN, callback, COMMIT; ROLLBACK y re-throw si el callback tira. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
```

- `max: 10` conexiones, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`.
- `pool.on('error', …)` que loguea y no tumba el proceso: un Postgres que se reinicia no puede matar
  la app.
- **Ninguna función de este archivo concatena SQL con datos.** Todo por parámetros. Es la única
  defensa contra inyección en un proyecto que va a recibir payloads de webhooks y de un ingest
  público.

## 7. `lib/day.ts`

El corte del día es la fuente de bugs número uno de este tipo de panel. Toda la aritmética de fechas
se hace **en SQL**, con `AT TIME ZONE`, y este archivo es el único lugar donde se arma:

```ts
/** El día local de un funnel para un instante. Se resuelve en Postgres, no en JS. */
export async function localDay(at: Date, timezone: string): Promise<string>;

/** Hoy en una TZ, como 'YYYY-MM-DD'. */
export async function today(timezone: string): Promise<string>;

/** Presets del selector de rango → { from, to } en la TZ dada. */
export type RangePreset = 'today' | 'yesterday' | '7d' | '14d' | '30d' | 'mtd' | 'all';
export async function resolveRange(preset: RangePreset, timezone: string): Promise<{ from: string; to: string }>;
```

`'all'` devuelve `from = '2000-01-01'`. No uses `Date` de JS para calcular "hace 7 días": con
horario de verano y una TZ distinta a la del server te corre un día y nadie se da cuenta.

Escribí tests de `resolveRange` con `vitest` (necesitan la base: si no hay `DATABASE_URL`, el test se
salta con `it.skip`, no falla).

## 8. `lib/funnels.ts`

```ts
export type Funnel = { id: number; slug: string; name: string; timezone: string;
                       sellCurrency: string; variants: string[]; color: string; active: boolean };

export async function listFunnels(opts?: { includeInactive?: boolean }): Promise<Funnel[]>;
export async function getFunnelBySlug(slug: string): Promise<Funnel | null>;
export async function getFunnelById(id: number): Promise<Funnel | null>;
/** Resuelve el funnel a partir de la ingest key en claro. Hashea y busca por hash. */
export async function getFunnelByIngestKey(key: string): Promise<Funnel | null>;
export async function listSteps(funnelId: number): Promise<
  { stepIndex: number; slug: string; label: string; kind: string; countsInFunnel: boolean }[]>;
```

`getFunnelByIngestKey` hace `sha256(key)` en hex y compara contra `ingest_key_hash`. Cachealo en
memoria 60 segundos (`Map<string, {funnel, expires}>`): el ingest lo llama en cada request y no tiene
sentido pegarle a la base para eso.

## 9. `lib/fx.ts` — solo lectura

Este archivo lo crea T01 aunque el **fetcher** lo escriba T03, porque T04 lo necesita para convertir
y los dos corren en paralelo. Acá va únicamente la lectura y la conversión:

```ts
export type FxLookup = { rate: number; day: string; stale: boolean; source: string };

/**
 * Cotización para un día. Si no existe la del día pedido, devuelve la más
 * reciente anterior con stale=true. Si no hay ninguna, devuelve null: el
 * llamador guarda la venta sin amount_eur, nunca la descarta.
 */
export async function getRate(day: string, base: string, quote: string): Promise<FxLookup | null>;

/** Convierte y redondea a 2 decimales. Null si no hay cotización. */
export async function toEur(amount: number, currency: string, day: string):
  Promise<{ amountEur: number; rate: number; fxDay: string; stale: boolean } | null>;
```

Si `currency === 'EUR'`, `toEur` devuelve el mismo monto con `rate = 1` y `stale = false`, sin tocar
la base.

## 10. `lib/types.ts`

Los tipos compartidos entre tasks. Solo lo que cruza fronteras: `IngestPayload`, `IngestEvent`
(los del §4 del plan), `EventName` (union del vocabulario cerrado del §6), `Tier`, `OrderStatus`,
`FunnelStepRow`. Nada de tipos internos de una sección.

`EventName` como union de strings literales, más un helper:

```ts
export const EVENT_NAMES = ['step_view','sales_view','checkout_click','upsell_view',
  'upsell_click','downsell_view','lead','purchase'] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export function isKnownEvent(name: string): name is EventName;
```

## 11. Scripts

**`scripts/migrate.ts`**
1. `CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.
2. Lee `db/migrations/*.sql` ordenados por nombre.
3. Para cada uno que no esté en la tabla: lo corre **dentro de una transacción** junto con el
   `INSERT` en `schema_migrations`. Si falla, `ROLLBACK` y el proceso sale con código 1 mostrando el
   archivo y el error de Postgres.
4. Imprime qué aplicó y qué salteó. Corrido dos veces, la segunda no aplica nada y sale 0.

**`scripts/ensure-partitions.ts`** — crea las particiones mensuales de `events` que falten para los
próximos N meses (default 3, `--months=`). Idempotente. Va por cron mensual.

**`scripts/set-ingest-key.ts <slug> <key>`** — hashea y hace
`UPDATE funnels SET ingest_key_hash = $2 WHERE slug = $1`. Si el slug no existe, sale 1. **No imprime
la key**, solo los primeros 6 caracteres del hash, para que no quede en el historial de la shell ni
en los logs.

## 12. README.md

Corto y operativo, no un ensayo. Cinco secciones: qué es, cómo levantarlo en local
(`docker compose up -d` → `cp .env.example .env` → `npm run db:migrate` → `npm run dev`), el mapa de
tablas en tres líneas, cómo generar y cargar una ingest key, y un puntero a `tasks/00-PLAN.md` para
lo demás.

## 13. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado.

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila
npx tsc --noEmit
npm run build

# 2 — la base levanta
docker compose up -d
docker compose ps                       # la columna PORTS de db tiene que decir 127.0.0.1
sleep 10 && docker compose exec db pg_isready -U panel -d panel

# 3 — las migraciones son idempotentes
npm run db:migrate
npm run db:migrate                      # la segunda vez: "0 aplicadas", exit 0

# 4 — el schema quedó completo (14 tablas + las particiones de events)
docker compose exec db psql -U panel -d panel -c "\dt"

# 5 — los seeds
docker compose exec db psql -U panel -d panel -c \
  "SELECT f.slug, count(s.*) AS pasos FROM funnels f
   LEFT JOIN funnel_steps s ON s.funnel_id = f.id GROUP BY 1 ORDER BY 1;"
# esperado exactamente:  chauhinchazon | 22
#                        reset         | 27

# 6 — el catálogo está alineado con el código
docker compose exec db psql -U panel -d panel -tAc \
  "SELECT string_agg(slug, ',' ORDER BY step_index) FROM funnel_steps
   WHERE funnel_id = (SELECT id FROM funnels WHERE slug='reset');"
grep -o "id: '[a-z_]*'" ~/Desktop/funnel/reset-app/lib/quiz-v2/data.ts | sed "s/id: '//;s/'//" | paste -sd,
# las dos líneas tienen que ser idénticas

# 7 — ninguna key real quedó en el seed
docker compose exec db psql -U panel -d panel -tAc \
  "SELECT slug, ingest_key_hash FROM funnels;"
# los dos hashes tienen que ser los placeholders PENDING_*

# 8 — tests
npm test
```

## 14. Cuándo parar

Si el orden de los pasos del código no coincide con el §3.12 del plan, o si `npm install` resuelve
una versión de `next` distinta de `14.2.5`: anotá en §10 del plan y **seguí** (ninguna de las dos
bloquea, pero las dos tienen que quedar registradas).

Si Postgres no levanta, si el puerto está ocupado en local o si una migración no es idempotente:
**pará**. Son bloqueantes y todo lo demás se construye encima.
