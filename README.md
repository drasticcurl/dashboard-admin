# Panel — dashboard de tracking y ventas unificado

Panel de tracking y ventas de los funnels **Chau Hinchazón** (testfunnel) y
**Protocolo Reset+** (reset-app): embudo paso a paso, ventas unificadas en
EUR/ARS, resumen multi-funnel y leads. Se sirve en `https://panel.hilvanapp.com`
con Postgres 16 propio (D5: los funnels solo hablan HTTP, nunca con la base; el
panel es el único cliente y la base escucha solo en `127.0.0.1`).

**En producción la base NO corre en Docker**: es el paquete `postgresql-16` de
Ubuntu (`/var/lib/postgresql/16/main`), y en la VPS no hay Docker instalado. El
`docker-compose.yml` de este repo es solo para desarrollo local. Los comandos
de operación están en `docs/runbook.md` y usan `psql` directo.

## Levantarlo en local

El Compose es una comodidad local para no instalar Postgres en tu máquina; no
tiene equivalente en el servidor.

```bash
docker compose up -d          # Postgres 16 en 127.0.0.1:5432 (SOLO local)
cp .env.example .env          # completar password + DATABASE_URL
npm install
npm run db:migrate            # schema completo + seeds (idempotente)
npm run dev                   # panel en http://localhost:3005
```

Si el `5432` del host está ocupado, cambiar `DB_PORT=5433` en `.env` (y el
puerto en `DATABASE_URL`).

## Mapa de tablas

- `funnels` + `funnel_steps`: catálogo de funnels y sus pasos (el funnel N+1
  aparece con un INSERT, sin migración).
- `sessions` (+ `events` particionada por mes): el embudo mide sesiones
  distintas con `max_step_index`; `events` es el log crudo con retención de
  180 días por DROP de partición.
- `orders` + `order_items` + `product_map`/`shop_map`: ventas de todos los
  funnels con moneda original + conversión EUR congelada (`fx_rates`).
- `ingest_errors` + `webhook_events` + `settings`: red de seguridad (nada se
  descarta) y configuración.

## Ingest keys

La key en claro vive en el `.env.production` de cada funnel; acá se guarda
solo su hash. Para cargar o rotar una:

```bash
openssl rand -hex 32                       # generar
npm run db:ingest-key -- chauhinchazon <key>
npm run db:ingest-key -- reset <key>       # solo imprime el prefijo del hash
```

Si una key queda sin cargar, el placeholder `PENDING_SET_INGEST_KEY_*` hace
que el ingest devuelva 401 en vez de aceptar cualquier cosa.

## Documento maestro

Todo lo demás (schema canónico, contratos congelados del ingest y del webhook,
vocabulario de eventos, ownership de archivos) vive en `tasks/00-PLAN.md`.

---

**Nota de versiones:** `npm install` resolvió las siguientes versiones sobre
este `package.json` (declarado con los rangos de `testfunnel` para correr en el
Node 20.20.2 de la VPS): `next` 14.2.5 (exacta), `pg` 8.23.0, `@types/pg`
8.21.0, `tsx` 4.23.12. Las tres últimas quedaron dentro de su rango declarado
(`^8.13.1`, `^8.11.10`, `^4.19.2`), así que no se tocó el `package.json`.
