# Este repo lo deployan DOS paneles distintos

Lo primero que hay que saber antes de tocar cualquier cosa acá.

`github.com/drasticcurl/dashboard-admin` está clonado **dos veces** en la misma
VPS, y las dos instancias deployan de `origin/main`:

| | hilvanapp | infinix |
|---|---|---|
| Dominio | `panel.hilvanapp.com` | `panel.infinixapp.com` |
| Path | `/srv/panel` | `/srv/panel-infinix` |
| Puerto / PM2 | 3005 · `panel-3005` | 3007 · `panel-infinix-3007` |
| Base | `panel` | `panel_infinix` |
| Moneda de reporte | **EUR** | **USD** |
| Marca | **Hilvan** | **Infinix App** |
| Historial de ventas | años de datos reales | arrancó vacío (2026-08-30) |
| Módulo de Anuncios | activo, con worker | **apagado**, sin worker |

**Consecuencia práctica:** un valor hardcodeado que dependa del proyecto le
cambia el comportamiento a las dos en su próximo deploy. Y como el deploy hace
`git reset --hard origin/main`, no se puede "arreglar a mano" en una instancia:
el próximo deploy lo revierte.

## Lo que varía por instancia va por env var, con default al valor de hilvanapp

| Var | Default | Dónde vive |
|---|---|---|
| `PANEL_BRAND` | `Hilvan` | `lib/brand.ts` |
| `NEXT_PUBLIC_REPORT_CURRENCY` | `EUR` | `lib/moneda-reporte.ts` |
| `DATABASE_URL`, `DASHBOARD_PASSWORD`, `NEXT_PUBLIC_SITE_URL` | — | `shared/.env.production` |

El default **siempre** es el valor histórico de hilvanapp. Es lo que hace que
agregar una instancia no toque a la que ya factura: la que no declara la variable
queda byte-idéntica.

Si agregás algo que dependa de la moneda o de la marca, seguí ese patrón. No
inventes un default "neutro": un default vacío o genérico le cambia la pantalla a
la instancia que ya estaba funcionando, sin que nadie lo haya pedido.

## La moneda de reporte no es solo un formato

Está en tres capas y las tres importan:

1. **El fetcher de cotizaciones** (`lib/fx-fetch.ts`). El par que se pide y bajo
   qué `quote` se archiva en `fx_rates`. Ojo que dolarapi tiene dos familias de
   ruta (`/cotizaciones/eur` y `/dolares/oficial`): no se generan concatenando el
   código de moneda.
2. **La conversión que se congela al insertar** (`lib/fx.ts:toReportCurrency`,
   llamada desde `lib/orders/upsert.ts`). El monto convertido se guarda en la fila
   y **no se recalcula al leer**, a propósito: un reporte de marzo no puede cambiar
   porque hoy se movió el dólar.
3. **El formato** (`fmtMoney(n, MONEDA_REPORTE)` y `SIMBOLO_REPORTE`).

Por (2), **cambiar `NEXT_PUBLIC_REPORT_CURRENCY` en una instancia con historial
mezcla dos monedas en la misma columna sin que nada falle.** Requiere cargar
`fx_rates` con el par nuevo para todo el rango y reconvertir `orders`, `ad_spend`
y `daily_metrics`. `scripts/backfill-fx.ts` **no** sirve para eso: su WHERE saltea
lo que ya tiene `amount_eur`.

Las tablas de finanzas son el caso irrecuperable: no guardan moneda de origen ni
cotización, los montos fueron **tipeados**. Convertirlas es una decisión de
negocio, no de código.

### Las columnas se siguen llamando `_eur` y está bien

`orders.amount_eur`, `ad_spend.spend_eur`, `daily_metrics.revenue_gross_eur` y
diez más. No se renombraron: son 13 columnas en 7 tablas más los CHECKs de las
migraciones 022 y 028 que las nombran, y el nombre de una columna no cambia lo que
hay adentro. **Lo que cambió es el significado**: con `MONEDA_REPORTE='USD'`,
`amount_eur` contiene dólares. Está documentado en `lib/moneda-reporte.ts`.

## El deploy de infinix vive FUERA del repo

```bash
sudo -u deploy bash /srv/panel/deploy.sh              # NO existe: hilvanapp usa el del repo
sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh  # hilvanapp
sudo -u deploy bash /srv/panel-infinix/deploy.sh      # infinix ← fuera del repo
```

`/srv/panel-infinix/deploy.sh` es una adaptación del de este repo. Está afuera
porque el repo es compartido y su `git reset --hard` borraría un archivo propio de
la instancia guardado adentro. Diferencias:

- `BASE`, puerto, nombre de PM2 y base de test propios. El del repo tiene
  `/srv/panel` y `panel-3005` hardcodeados, y calcula la base de test como
  `panel_test` con el nombre fijo — o sea que dos paneles correrían sus tests
  contra la misma base.
- **No** corre `verificar-token-ads.ts` ni levanta `panel-reglas`. Ese worker
  pausa y reactiva campañas de Meta: gasta plata real. Y el chequeo del token
  abortaría el deploy por una feature que esa instancia no usa.
- Tiene un **guard de identidad**: aborta si `DATABASE_URL` no termina en
  `/panel_infinix` o si `NEXT_PUBLIC_SITE_URL` no contiene `panel.infinixapp.com`.
  Existe porque los dos `shared/.env.production` tienen las mismas claves con
  valores distintos, y un env cruzado deja un panel escribiendo en la base del
  otro **sin que nada falle**: build OK, tests OK, health check OK.

El deploy de hilvanapp todavía no tiene ese guard.

## Bootstrap de una base nueva: la migración 021 aborta

`db/migrations/021_reglas_por_cuenta.sql` exige que exista una cuenta
publicitaria activa (`ad_accounts.active AND platform='meta'`), porque expande las
6 reglas que seedea la 016. En una base vacía tira:

```
021 abortada: no existe ninguna Cuenta_Activa
```

La secuencia que funciona está en `/root/panel-infinix-migrate.sh` (en la VPS):
migrar 001–020, insertar una cuenta placeholder, migrar 021–028, y borrar primero
las reglas y después el placeholder — en ese orden, porque el FK
`ad_rules_cuenta_fk` es `ON DELETE RESTRICT`.

## Antes de tocar algo, mirá dónde estás

```bash
ssh funnel-vps
sudo bash /srv/estado.sh    # mapa en vivo: procesos, releases, env, cotizaciones
cat /srv/PROYECTOS.md       # el porqué y las trampas
```

`/srv/estado.sh` muestra, entre otras cosas, qué base y qué moneda tiene cada
panel. Si dos filas dicen la misma base, hay un env cruzado.
