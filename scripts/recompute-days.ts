#!/usr/bin/env node
/**
 * Recalcula el DÍA de ventas, sesiones y eventos con la zona horaria vigente
 * de cada funnel.
 *
 * POR QUÉ HACE FALTA
 * `orders.day`, `sessions.day` y `events.day` son columnas guardadas: se
 * calculan una vez, al ingerir, con `funnels.timezone`. Eso es deliberado (un
 * reporte no puede moverse porque el server cambió de zona), pero tiene una
 * consecuencia: cambiar la zona del funnel en /config no reexpresaba nada. El
 * panel seguía cortando los días con la zona vieja y no había forma de darse
 * cuenta salvo comparando contra Shopify o contra Meta.
 *
 * Con la tienda en Argentina (UTC−3) y las cuentas de anuncios en Lisboa
 * (UTC+1) el corrimiento es de 4 horas: todo lo que se vende entre las 20:00 y
 * la medianoche argentina, Meta ya lo cuenta en el día siguiente. En un día con
 * 175 ventas eso son 40 órdenes de diferencia, y las dos cifras son "correctas"
 * según qué calendario se use.
 *
 * ESTO NO ES LO MISMO QUE EL BACKFILL DE COMISIONES
 * Una comisión se congela porque es una DECISIÓN del negocio en el momento de
 * la venta; recalcularla reescribe historia. El día no: es una función pura de
 * (timestamp, zona). Recalcularlo no cambia ninguna decisión, restaura la
 * coherencia entre lo guardado y la zona configurada. Por eso puede correr
 * automáticamente cuando se guarda una zona nueva.
 *
 * QUÉ NO TOCA
 * `ad_spend.day` viene de Meta ya agregado por día en la zona de la CUENTA. Sin
 * el desglose por hora no se puede reexpresar sin inventar un reparto, así que
 * se deja como está: la zona de la cuenta se guarda en `ad_accounts.timezone` y
 * el panel avisa cuando no coincide con la de la tienda.
 *
 * Uso: tsx scripts/recompute-days.ts [--funnel=slug] [--dry-run]
 * Después hay que correr el rollup (lo avisa al final; la UI lo hace sola).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q, q1, tx } from '../lib/db';
import { listFunnels } from '../lib/funnels';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/** Las tres tablas que guardan un día derivado, con el timestamp del que sale. */
const TABLAS = [
  { tabla: 'orders', ts: 'purchased_at', etiqueta: 'ventas' },
  { tabla: 'sessions', ts: 'started_at', etiqueta: 'sesiones' },
  { tabla: 'events', ts: 'occurred_at', etiqueta: 'eventos' },
] as const;

export type TablaCambio = { etiqueta: string; movidas: number };

export type FunnelCambio = {
  slug: string;
  timezone: string;
  tablas: TablaCambio[];
  /** Rango de días afectado, para saber qué reconstruir del rollup. */
  minDay: string | null;
  maxDay: string | null;
};

export type RecomputeResult = {
  funnels: FunnelCambio[];
  totalMovidas: number;
  minDay: string | null;
  maxDay: string | null;
};

function dayStr(d: Date | string | null): string | null {
  if (d === null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function menor(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function mayor(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Recalcula el día de un funnel (o de las ventas sin funnel, con funnelId
 * null). Devuelve cuántas filas cambiaron de día y el rango afectado, que es lo
 * que hay que reconstruir del rollup: incluye los días de ORIGEN y de DESTINO,
 * porque una fila que se muda deja el día viejo con un total distinto.
 */
async function recomputeUno(
  funnelId: number | null,
  slug: string,
  timezone: string,
  dryRun: boolean,
): Promise<FunnelCambio> {
  const cambio: FunnelCambio = { slug, timezone, tablas: [], minDay: null, maxDay: null };
  const cond = funnelId === null ? 'funnel_id IS NULL' : 'funnel_id = $2';
  const params = funnelId === null ? [timezone] : [timezone, funnelId];

  for (const t of TABLAS) {
    // `orders` es la única que puede tener funnel_id NULL; sessions y events
    // lo tienen NOT NULL, así que el cajón sin atribuir solo las recorre a
    // ellas.
    if (funnelId === null && t.tabla !== 'orders') continue;

    // El rango se mide ANTES de escribir y sobre las filas que van a cambiar:
    // después del UPDATE el día viejo ya no está en ninguna parte.
    const rango = await q1<{ min_old: Date | null; max_old: Date | null; min_new: Date | null; max_new: Date | null; n: string }>(
      `SELECT min(day) AS min_old, max(day) AS max_old,
              min((${t.ts} AT TIME ZONE $1)::date) AS min_new,
              max((${t.ts} AT TIME ZONE $1)::date) AS max_new,
              count(*)::text AS n
         FROM ${t.tabla}
        WHERE ${cond}
          AND day IS DISTINCT FROM (${t.ts} AT TIME ZONE $1)::date`,
      params,
    );
    const movidas = Number(rango?.n ?? 0);
    cambio.tablas.push({ etiqueta: t.etiqueta, movidas });
    if (movidas === 0) continue;

    cambio.minDay = menor(cambio.minDay, menor(dayStr(rango!.min_old), dayStr(rango!.min_new)));
    cambio.maxDay = mayor(cambio.maxDay, mayor(dayStr(rango!.max_old), dayStr(rango!.max_new)));

    if (dryRun) continue;

    // Una tabla por transacción: si `events` falla, `orders` no queda a medias.
    // El WHERE repite la comparación para no tocar las filas que ya están bien
    // (en `events` son decenas de miles y reescribirlas todas no aporta nada).
    await tx(async (c) => {
      await c.query(
        `UPDATE ${t.tabla} SET day = (${t.ts} AT TIME ZONE $1)::date
          WHERE ${cond}
            AND day IS DISTINCT FROM (${t.ts} AT TIME ZONE $1)::date`,
        params,
      );
    });
  }

  return cambio;
}

export async function runRecompute(opts: {
  slug?: string;
  dryRun: boolean;
}): Promise<RecomputeResult> {
  const todos = await listFunnels({ includeInactive: true });
  const funnels = opts.slug ? todos.filter((f) => f.slug === opts.slug) : todos;
  if (opts.slug && funnels.length === 0) throw new Error(`no existe el funnel '${opts.slug}'`);

  const out: RecomputeResult = { funnels: [], totalMovidas: 0, minDay: null, maxDay: null };

  for (const f of funnels) {
    const c = await recomputeUno(f.id, f.slug, f.timezone, opts.dryRun);
    out.funnels.push(c);
  }

  // Las ventas sin funnel usan la zona del dashboard, igual que al ingerirlas
  // (lib/orders/upsert.ts). Sin esto el cajón "sin atribuir" quedaría con un
  // corte distinto al del resto del panel.
  if (!opts.slug) {
    const tzDashboard = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
    const c = await recomputeUno(null, '(sin funnel)', tzDashboard, opts.dryRun);
    if (c.tablas.some((t) => t.movidas > 0)) out.funnels.push(c);
  }

  for (const c of out.funnels) {
    out.totalMovidas += c.tablas.reduce((a, t) => a + t.movidas, 0);
    out.minDay = menor(out.minDay, c.minDay);
    out.maxDay = mayor(out.maxDay, c.maxDay);
  }

  return out;
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let slug: string | undefined;
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--funnel=')) slug = a.slice('--funnel='.length);
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }

  const res = await runRecompute({ slug, dryRun });
  const verbo = dryRun ? 'moverían' : 'movieron';

  for (const c of res.funnels) {
    const detalle = c.tablas.map((t) => `${t.etiqueta} ${t.movidas}`).join(' · ');
    console.log(`  ${c.slug.padEnd(16)} ${c.timezone.padEnd(32)} ${detalle}`);
  }
  if (res.totalMovidas === 0) {
    console.log('\nTodos los días ya coinciden con la zona configurada. No hay nada que recalcular.');
    return;
  }
  console.log(`\nSe ${verbo} ${res.totalMovidas} filas de día (rango ${res.minDay}..${res.maxDay}).`);
  if (!dryRun) {
    console.log('Ahora reconstruí el rollup para que el Resumen use los días nuevos:');
    console.log(`  npm run rollup -- --from=${res.minDay} --to=${res.maxDay}`);
  }
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('recompute-days falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
