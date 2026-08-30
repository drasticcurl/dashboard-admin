#!/usr/bin/env node
/**
 * Completa las ventas que quedaron sin conversión o con la provisoria
 * (T03 §5): busca órdenes con amount_eur IS NULL o fx_stale = true y, cuando
 * ya existe la cotización EXACTA del día, la congela en la fila. Si el día
 * todavía no tiene cotización, la orden queda para la corrida siguiente.
 *
 * Uso: tsx scripts/backfill-fx.ts [--limit=N] [--dry-run]
 *  --limit=N    (default 5000) para no barrer 3 años de una
 *  --dry-run    imprime lo que haría sin escribir nada
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q, tx } from '../lib/db';
import { toReportCurrency } from '../lib/fx';
import { MONEDA_REPORTE } from '../lib/moneda-reporte';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export type BackfillResult = {
  updated: number;
  stillStale: number;
  fromDay: string | null;
  toDay: string | null;
};

type OrderRow = { id: string | number; amount: string; currency: string; day: Date | string };

// pg >= 8.11 devuelve `date` como Date local, no como 'YYYY-MM-DD': se
// recompone con los componentes locales porque toISOString correría un día en
// una máquina con TZ negativa (el 11 de agosto ART es 10T23Z).
function dayStr(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtRate(rate: number): string {
  return rate.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

export async function runBackfill(opts: { limit: number; dryRun: boolean }): Promise<BackfillResult> {
  // El plan define el WHERE como contrato: monedas que no son la de reporte (la
  // regla "no recalcular lo ya congelado" vive en que fx_stale=true solo lo pone
  // quien convirtió sin cotización del día).
  //
  // OJO SI ALGUN DIA SE CAMBIA LA MONEDA DE REPORTE EN UNA BASE CON HISTORIAL:
  // este WHERE saltea todo lo que ya tiene amount_eur, así que NO sirve para
  // reconvertir ventas viejas de una moneda a otra. Para eso hay que nulificar
  // amount_eur primero, o escribir un script aparte.
  const rows = await q<OrderRow>(
    `SELECT id, amount, currency, day FROM orders
     WHERE currency <> $2 AND (amount_eur IS NULL OR fx_stale = true)
     ORDER BY day
     LIMIT $1`,
    [opts.limit, MONEDA_REPORTE],
  );

  // Se actualiza solo con la cotización exacta del día: toEur devuelve
  // stale=true cuando usó una anterior, y esa orden se deja como está hasta
  // que el cron traiga la del día (el backfill la completa después).
  const todo: Array<{
    id: string | number;
    amount: number;
    currency: string;
    day: string;
    amountEur: number;
    rate: number;
    fxDay: string;
  }> = [];
  let stillStale = 0;
  for (const row of rows) {
    const day = dayStr(row.day);
    const conv = await toReportCurrency(Number(row.amount), row.currency, day);
    if (conv && !conv.stale) {
      todo.push({
        id: row.id,
        amount: Number(row.amount),
        currency: row.currency,
        day,
        amountEur: conv.amountEur,
        rate: conv.rate,
        fxDay: conv.fxDay,
      });
    } else {
      stillStale += 1;
    }
  }

  if (opts.dryRun) {
    for (const t of todo) {
      console.log(
        `[dry-run] id=${t.id} ${t.day}: ${t.amount.toFixed(2)} ${t.currency} → ${t.amountEur.toFixed(2)} EUR (rate ${fmtRate(t.rate)}, día ${t.fxDay})`,
      );
    }
  } else if (todo.length > 0) {
    // Todo el batch en una transacción: un UPDATE que falla a mitad de camino
    // no puede dejar la mitad de un día convertida y la otra no.
    await tx(async (c) => {
      for (const t of todo) {
        await c.query(
          `UPDATE orders SET amount_eur = $2, fx_rate = $3, fx_day = $4, fx_stale = false
           WHERE id = $1`,
          [t.id, t.amountEur, t.rate, t.fxDay],
        );
      }
    });
  }

  // ORDER BY day deja las filas ordenadas: el rango sale de la primera y la
  // última sin un ORDER BY extra.
  const fromDay = rows.length > 0 ? dayStr(rows[0].day) : null;
  const toDay = rows.length > 0 ? dayStr(rows[rows.length - 1].day) : null;

  if (rows.length === 0) {
    console.log('backfill: ninguna orden pendiente');
  } else {
    const verb = opts.dryRun ? 'actualizaría' : 'actualizó';
    console.log(`backfill: ${verb} ${todo.length}, ${stillStale} siguen stale (días ${fromDay}..${toDay})`);
  }
  return { updated: todo.length, stillStale, fromDay, toDay };
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let limit = 5000;
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit inválido: '${a.slice(8)}' (espera un entero >= 1)`);
      limit = n;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`argumento desconocido: ${a}`);
    }
  }
  await runBackfill({ limit, dryRun });
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('backfill-fx falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
