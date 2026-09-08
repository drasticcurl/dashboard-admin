#!/usr/bin/env node
/**
 * Genera el análisis con IA del Resumen y de Finanzas, una vez por día.
 *
 * Uso:
 *   npm run ia:insights                  # los dos ámbitos
 *   npm run ia:insights -- --ambito=finanzas
 *   npm run ia:insights -- --dias=14     # ventana del Resumen
 *   npm run ia:insights -- --forzar      # ignora la caché por huella
 *
 * ─── ESTE SCRIPT ES EL QUE HACE QUE LA PANTALLA NO GASTE ───────────────────
 * El panel nunca llama a OpenAI: lee la fila que este script deja. /resumen es
 * `force-dynamic` y repite el pedido cada minuto, así que generar en el render
 * serían ~1.440 llamadas por día por pestaña abierta.
 *
 * ─── ANALIZA DIAS CERRADOS, NO HOY ─────────────────────────────────────────
 * La ventana termina AYER. Hoy es un día parcial por definición: un insight sobre
 * medio día compara medio día contra siete completos y siempre dice que se cayó
 * todo. Además, terminar en ayer es lo que hace que la huella cambie una sola vez
 * por día: si incluyera hoy, cada venta nueva la cambiaría y una corrida manual
 * pagaría de nuevo.
 *
 * ─── SIN OPENAI_API_KEY SALE CON 0 ─────────────────────────────────────────
 * No es un error: es una instancia que no tiene la feature. Este repo lo deployan
 * dos paneles distintos y el que no declare la key tiene que quedar igual que
 * antes, sin ensuciar el log con fallas todas las noches.
 *
 * ─── NO CORRE EN LA VPS DE INFINIX TODAVIA ─────────────────────────────────
 * `deploy/cron.panel` es el crontab de hilvanapp. `/srv/panel-infinix/deploy.sh`
 * vive FUERA del repo y hay que ver si instala este archivo; si no lo instala,
 * esta línea sólo existe en hilvanapp. En cualquier caso, sin key sale limpio.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q1 } from '../lib/db';
import { today } from '../lib/day';
import { getOverviewData } from '../lib/queries/overview';
import { getFinanceOverview, listMovements, listScheduledPayments } from '../lib/queries/finance';
import { getSaldoOverview, serieDiaria } from '../lib/queries/saldo';
import { reconciliarMeses } from '../lib/queries/reconciliacion';
import { armarBriefResumen, INSTRUCCIONES_RESUMEN } from '../lib/ia/brief-resumen';
import { armarBriefFinanzas, INSTRUCCIONES_FINANZAS } from '../lib/ia/brief-finanzas';
import { generarInsight, usoDelDia, LimiteIaError, type AmbitoInsight } from '../lib/ia/insights';
import { hayIa, IaError, modelo } from '../lib/ia/openai';

// tsx no carga .env solo; en producción las variables vienen del
// --env-file del cron y este archivo no existe.
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/** Cuántos días cerrados mira el Resumen. 7 da una semana completa contra la anterior. */
const DIAS_POR_DEFECTO = 7;

/** Cuántos meses reconcilia Finanzas. 6 alcanza para ver si un hueco se acumula. */
const MESES_FINANZAS = 6;

type Opciones = {
  ambitos: AmbitoInsight[];
  dias: number;
  forzar: boolean;
};

export function parsearArgs(args: string[]): Opciones {
  let ambitos: AmbitoInsight[] = ['resumen', 'finanzas'];
  let dias = DIAS_POR_DEFECTO;
  let forzar = false;

  for (const a of args) {
    if (a === '--forzar') {
      forzar = true;
      continue;
    }
    const ambito = /^--ambito=(.+)$/.exec(a);
    if (ambito) {
      const v = ambito[1]!;
      if (v === 'todos') ambitos = ['resumen', 'finanzas'];
      else if (v === 'resumen' || v === 'finanzas') ambitos = [v];
      else throw new Error(`--ambito inválido: "${v}" (resumen | finanzas | todos)`);
      continue;
    }
    const d = /^--dias=(\d+)$/.exec(a);
    if (d) {
      dias = Number(d[1]);
      if (dias < 1) throw new Error(`--dias tiene que ser >= 1, vino ${dias}`);
      continue;
    }
    throw new Error(`argumento desconocido: ${a}`);
  }

  return { ambitos, dias, forzar };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parsearArgs(args);

  if (!hayIa()) {
    console.log('ia:insights: OPENAI_API_KEY no está configurada, no hay nada que generar');
    return;
  }

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const hoy = await today(tz);

  // La ventana cerrada, resuelta en Postgres: es aritmética de `date`, así que un
  // cambio de horario de verano no la puede correr un día.
  const ventana = await q1<{ desde: string; hasta: string }>(
    `SELECT ($1::date - $2::int)::text AS desde, ($1::date - 1)::text AS hasta`,
    [hoy, opts.dias],
  );
  const rango = { from: ventana!.desde, to: ventana!.hasta };

  const uso = await usoDelDia();
  console.log(
    `ia:insights: modelo ${modelo()} · ${uso.usados}/${uso.techo} análisis usados hoy · ` +
      `ventana ${rango.from}..${rango.to}`,
  );

  let fallos = 0;
  for (const ambito of opts.ambitos) {
    try {
      const r =
        ambito === 'resumen'
          ? await generarResumen(rango, opts.forzar)
          : await generarFinanzas(hoy, opts.forzar);

      console.log(
        `  ${ambito}: ${r.insights.length} observaciones${r.deCache ? ' (de la caché, no se llamó a OpenAI)' : ''}`,
      );
      for (const ins of r.insights) console.log(`    [${ins.tono}] ${ins.titulo}`);
    } catch (err) {
      fallos++;
      // Los tres casos que valen la pena distinguir en el log, porque los tres se
      // arreglan distinto.
      if (err instanceof LimiteIaError) {
        console.error(`  ${ambito}: ${err.message}`);
      } else if (err instanceof IaError) {
        console.error(`  ${ambito}: falló la llamada a OpenAI (${err.causa}): ${err.message}`);
      } else {
        console.error(`  ${ambito}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Exit code 1 si algo falló, igual que finance-scheduled-payments: el cron
  // escribe a /var/log/panel/ia.log y un fallo silencioso sería un insight que
  // nunca se actualiza sin que nada lo diga.
  if (fallos > 0) process.exitCode = 1;
}

async function generarResumen(rango: { from: string; to: string }, forzar: boolean) {
  // NO se llama a ensureFreshAdSpend: eso refresca el gasto de HOY contra Meta y
  // la ventana termina ayer. El gasto de los días cerrados ya lo trajo
  // scripts/sync-ads.ts, y pedirle a Meta datos que ya están es una llamada de
  // más contra su rate limit.
  const data = await getOverviewData(rango);
  const brief = armarBriefResumen(data, rango);

  return generarInsight({
    ambito: 'resumen',
    instrucciones: INSTRUCCIONES_RESUMEN,
    brief,
    rango: { desde: rango.from, hasta: rango.to },
    origen: 'cron',
    ignorarCache: forzar,
  });
}

async function generarFinanzas(hoy: string, forzar: boolean) {
  const [reconciliacion, saldo, overview, movimientos, atrasados] = await Promise.all([
    reconciliarMeses(MESES_FINANZAS),
    getSaldoOverview(),
    getFinanceOverview(),
    listMovements({}),
    listScheduledPayments(),
  ]);
  const serieDelMes = await serieDiaria(hoy.slice(0, 7));

  const brief = armarBriefFinanzas({
    hoy,
    reconciliacion,
    ultimoPatrimonio: saldo.ultimo,
    faltanCargarHoy: overview.faltanCargarHoy,
    serieDelMes,
    movimientos,
    atrasados: atrasados.filter((a) => a.atrasado),
  });

  // El rango de Finanzas son los meses reconciliados, no la ventana de días del
  // Resumen: el patrimonio se lee por mes y guardar '2026-08-28..2026-09-03'
  // haría creer que el análisis habla de esa semana.
  const desde = reconciliacion.length ? `${reconciliacion[0]!.month}-01` : hoy;

  return generarInsight({
    ambito: 'finanzas',
    instrucciones: INSTRUCCIONES_FINANZAS,
    brief,
    rango: { desde, hasta: hoy },
    origen: 'cron',
    ignorarCache: forzar,
  });
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('ia:insights falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
