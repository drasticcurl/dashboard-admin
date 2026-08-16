#!/usr/bin/env node
/**
 * Pagos programados de Finanzas (plan FINANZAS §5) — genera el gasto de cada
 * pago programado activo cuyo día ya pasó este mes y todavía no se ejecutó.
 *
 * Uso (declarado en package.json por T01):
 *   npm run finance:pagos
 *
 * No tiene argumentos de rango: los pagos son siempre "a partir de hoy".
 * La idempotencia es estructural: la PK (scheduled_payment_id, month) de
 * finance_scheduled_payment_runs rechaza la segunda ejecución del mismo mes,
 * así que correr este script dos veces el mismo día no duplica ningún gasto.
 *
 * Corre DESPUÉS de finance-rollup.ts en el cron de producción: mantener el
 * orden "profit antes que gastos del día" hace que la UI vea los dos ya
 * actualizados juntos y no a medias.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool } from '../lib/db';
import { today } from '../lib/day';
import { runScheduledPayments } from '@/lib/queries/finance';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<{ ejecutados: string[] }> {
  if (args.length > 0) throw new Error(`argumento desconocido: ${args[0]}`);

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const todayStr = await today(tz);
  const res = await runScheduledPayments(todayStr);
  console.log(`finance-pagos: ${res.ejecutados.length} pagos ejecutados (${todayStr})`);
  for (const nombre of res.ejecutados) {
    console.log(`  - ${nombre}`);
  }
  return res;
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('finance-pagos falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
