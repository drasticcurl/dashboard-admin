#!/usr/bin/env node
/**
 * Aviso push del profit del día a la PWA (`npm run push:profit`).
 *
 * El cron lo corre CADA HORA y el script decide si a esta hora toca avisar,
 * mirando la hora de DASHBOARD_TZ (Lisboa) y no la del servidor (Berlín, 1 h
 * adelante). Así no hay que traducir horarios en el crontab, no se corre con el
 * cambio de horario y cada instancia avisa en SU zona horaria.
 *
 * Horas: `PUSH_HORAS` (lista separada por comas), default 0,6,10,14,18,22.
 * A las 00 el aviso es el CIERRE del día que terminó (el de hoy está en cero);
 * el resto, cómo viene hoy.
 *
 * El número es `totals.resultEur` de `getOverviewData` con el rango hoy..hoy:
 * EXACTAMENTE el widget Resultado del Resumen (neto − gasto de ads).
 *
 * Flags:
 *   --forzar        manda aunque no sea una de las horas (para probar).
 *   --seco          arma el aviso y lo imprime, sin mandar nada.
 *
 * Sin claves VAPID sale con 0 y una línea de log: la instancia que no las
 * declara no tiene la feature.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q1 } from '../lib/db';
import { today } from '../lib/day';
import { getOverviewData } from '../lib/queries/overview';
import { ensureFreshAdSpend } from '../lib/ads/live';
import { SIMBOLO_REPORTE } from '../lib/moneda-reporte';
import { armarAvisoProfit } from '../lib/push/mensajes';
import { enviarATodos, leerVapid } from '../lib/push/enviar';

const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const HORAS_POR_DEFECTO = [0, 6, 10, 14, 18, 22];

export function leerHoras(raw: string | undefined): number[] {
  if (!raw?.trim()) return HORAS_POR_DEFECTO;
  const horas = raw.split(',').map((h) => Number(h.trim()));
  if (horas.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw new Error(`PUSH_HORAS inválido: "${raw}" (horas 0-23 separadas por coma)`);
  }
  return horas;
}

/** La hora (0-23) de ahora en la zona dada. */
export function horaEn(tz: string, ahora: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(ahora);
  return Number(h);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const forzar = args.includes('--forzar');
  const seco = args.includes('--seco');
  const desconocido = args.find((a) => a !== '--forzar' && a !== '--seco');
  if (desconocido) throw new Error(`argumento desconocido: ${desconocido}`);

  if (!seco && !leerVapid()) {
    console.log('push:profit: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no están configuradas, no hay nada que mandar');
    return;
  }

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const hora = horaEn(tz);
  if (!forzar && !leerHoras(process.env.PUSH_HORAS).includes(hora)) return;

  const hoy = await today(tz);
  const cierre = hora === 0;
  const dia = cierre
    ? (await q1<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [hoy]))!.d
    : hoy;

  // Lo mismo que hace el Resumen antes de leer: traer el gasto de Meta al día y
  // reconstruir el rollup. Sin esto el aviso mezcla ventas de este minuto con el
  // gasto del sync de hace una hora. `correrSync` pide hoy Y ayer, así que cubre
  // también el cierre de medianoche. No tira nunca: si Meta no contesta, se avisa
  // con lo último guardado.
  const frescura = await ensureFreshAdSpend(hoy, hoy, { forzar: true, timeoutMs: 60_000 });
  if (frescura.error) console.error(`push:profit: el gasto de Meta no se pudo refrescar: ${frescura.error}`);

  const { totals } = await getOverviewData({ from: dia, to: dia });
  const aviso = armarAvisoProfit(
    {
      resultado: totals.resultEur,
      neto: totals.netEur,
      gasto: totals.adSpendEur,
      ventas: totals.orders,
      roi: totals.roi,
      simbolo: SIMBOLO_REPORTE,
      cierre,
    },
    `${hoy}T${hora}`,
  );

  if (seco) {
    console.log(`${aviso.titulo}\n${aviso.cuerpo}`);
    return;
  }

  const r = await enviarATodos({ titulo: aviso.titulo, cuerpo: aviso.cuerpo, url: '/resumen', tag: 'profit' });
  console.log(
    `push:profit ${dia} ${String(hora).padStart(2, '0')}h · ${aviso.tramo} · ${aviso.titulo} · ` +
      `enviados ${r.enviados}, borrados ${r.borrados}, fallidos ${r.fallidos}`,
  );
  if (r.fallidos > 0 && r.enviados === 0) process.exitCode = 1;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('push:profit falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
