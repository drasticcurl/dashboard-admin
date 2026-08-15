/**
 * Gasto de anuncios en vivo: refresca `ad_spend` cuando se abre una pantalla
 * que incluye el día de hoy.
 *
 * EL PROBLEMA
 * Las ventas se ven al instante: el webhook las escribe cuando pasan y las
 * pantallas leen la base en cada request (`dynamic = 'force-dynamic'`). El gasto,
 * en cambio, solo entraba por el cron horario. Con el ROI y el ROAS mirando las
 * dos cosas a la vez, media cuenta estaba al día y la otra podía tener 50
 * minutos de atraso, y el número no servía para decidir si cortar una campaña.
 *
 * CÓMO
 * En el render, si el rango incluye hoy y el último sync tiene más de TTL
 * segundos, se llama a Meta y se espera. Tres defensas para que eso no sea una
 * mala idea:
 *
 *   1. TTL (60 s por defecto): apretar F5 diez veces seguidas hace UNA llamada.
 *      Sin esto, cada request pegaría a Meta y aparecerían los rate limits.
 *   2. Timeout propio, más corto que el de la API: si Meta tarda, la pantalla se
 *      dibuja con lo que hay en la base en vez de quedarse colgada. El sync
 *      sigue de fondo y el próximo refresh ya lo encuentra escrito.
 *   3. Nunca tira: un error de Meta no puede dejar sin Resumen ni sin Ventas. Se
 *      devuelve en `error` y la pantalla lo muestra al lado del número.
 *
 * Además se guarda el promise en vuelo: dos requests simultáneos comparten el
 * mismo sync en vez de disparar dos.
 *
 * El cron sigue existiendo y no es redundante: cubre las horas en las que nadie
 * abre el panel, y reprocesa ayer, que Meta ajusta después del cierre.
 */

import { q1 } from '../db';
import { rollupRange } from '@/scripts/rollup';
import { syncAdSpend } from './sync';

/** Segundos que se considera "fresco" un sync. Configurable por si Meta aprieta. */
function ttlSegundos(): number {
  const n = Number(process.env.ADS_LIVE_TTL_SECONDS ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/** Cuánto se espera al sync antes de dibujar con lo que ya está guardado. */
function timeoutMs(): number {
  const n = Number(process.env.ADS_LIVE_TIMEOUT_MS ?? 8000);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

export type FrescuraAds = {
  /** Cuándo se sincronizó por última vez (ISO), null si nunca. */
  syncedAt: string | null;
  /** Antigüedad en segundos, null si nunca se sincronizó. */
  ageSeconds: number | null;
  /** Se disparó una llamada a Meta en este request. */
  refreshed: boolean;
  /** Último error de sync, si hay. La pantalla sigue con lo de la base. */
  error: string | null;
};

async function leerFrescura(): Promise<Omit<FrescuraAds, 'refreshed'>> {
  // min() y no max(): con dos cuentas, la más atrasada es la que manda. Decir
  // "hace 10 s" porque una de las dos se sincronizó recién ocultaría que la otra
  // está parada. El error se trae de la misma consulta porque `last_sync_at` se
  // actualiza también cuando el sync falla (así se sabe que se intentó): sin el
  // error, un fallo se vería como un dato fresco.
  const row = await q1<{ synced_at: string | null; age: string | null; err: string | null }>(
    `SELECT min(last_sync_at)::text AS synced_at,
            EXTRACT(EPOCH FROM (now() - min(last_sync_at)))::text AS age,
            max(last_sync_error) AS err
       FROM ad_accounts WHERE active AND platform = 'meta'`,
  );
  if (!row || row.synced_at === null) {
    return { syncedAt: null, ageSeconds: null, error: row?.err ?? null };
  }
  return {
    syncedAt: row.synced_at,
    ageSeconds: Math.round(Number(row.age)),
    error: row.err ?? null,
  };
}

// El promise en vuelo NUNCA rechaza: el catch está adentro. Así el Promise.race
// del llamador no puede tirar, y un fallo de Meta no deja un rechazo sin
// manejar cuando gana el timeout.
let enVuelo: Promise<void> | null = null;

async function correrSync(hoy: string): Promise<void> {
  // Se pide hoy Y ayer en la misma llamada: `time_increment=1` devuelve los dos
  // días en una sola respuesta, así que no cuesta una request extra, y cubre dos
  // cosas — los ajustes que Meta hace sobre ayer, y el desfasaje cuando la zona
  // de la cuenta no es la de la tienda (el "hoy" de Meta puede ser el ayer de
  // acá).
  const desde = await q1<{ day: string }>(`SELECT ($1::date - 1)::text AS day`, [hoy]);
  const from = desde!.day;
  await syncAdSpend({ from, to: hoy });
  // El Resumen lee de daily_metrics, no de ad_spend: sin esto el gasto quedaría
  // fresco en Ventas y viejo en Resumen.
  await rollupRange({ from, to: hoy });
}

/**
 * Refresca el gasto si hace falta y devuelve qué tan fresco quedó.
 *
 * `hasta` es el último día del rango que se está mirando y `hoy` el día actual,
 * los dos ya resueltos en la zona del funnel. Si el rango no llega a hoy no hay
 * nada en vivo que traer: el gasto de un día cerrado no se mueve.
 *
 * `opts.forzar` (R1 c7): saltea SOLO la comparación contra el TTL. Es lo único
 * que usa el Boton_Actualizar. El promise en vuelo compartido se mantiene, así
 * que dos pestañas apretando el botón a la vez siguen compartiendo un solo
 * sync. Sigue sin tirar nunca.
 *
 * `opts.timeoutMs` (R1 c7): presupuesto de espera antes de dibujar con lo que
 * hay. Default el de hoy (8 s); el botón pide 60 s.
 */
export async function ensureFreshAdSpend(
  hasta: string,
  hoy: string,
  opts?: {
    /** Ignora el TTL de frescura (R1 c7). Sólo el Boton_Actualizar lo usa. */
    forzar?: boolean;
    /** Presupuesto de espera. Default el de hoy (8 s); el botón usa 60 s. */
    timeoutMs?: number;
  },
): Promise<FrescuraAds> {
  const antes = await leerFrescura();
  if (hasta < hoy) return { ...antes, refreshed: false };

  const ttl = ttlSegundos();
  if (!opts?.forzar && antes.ageSeconds !== null && antes.ageSeconds < ttl) {
    return { ...antes, refreshed: false };
  }

  if (!enVuelo) {
    let fallo: string | null = null;
    enVuelo = correrSync(hoy)
      .catch((e) => {
        fallo = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        enVuelo = null;
        if (fallo) console.error('ads live: el sync falló:', fallo);
      });
  }

  let alarma: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    enVuelo,
    new Promise<void>((resolve) => {
      alarma = setTimeout(resolve, opts?.timeoutMs ?? timeoutMs());
    }),
  ]);
  if (alarma) clearTimeout(alarma);

  const despues = await leerFrescura();
  return { ...despues, refreshed: true };
}
