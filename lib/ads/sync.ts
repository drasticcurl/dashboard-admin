/**
 * El sync de gasto de Meta, como función: lo usa el cron (scripts/sync-ads.ts)
 * y también el panel, que lo dispara al abrir una pantalla que incluye hoy.
 *
 * POR QUÉ ESTÁ ACÁ Y NO DENTRO DEL SCRIPT
 * Vivía dentro del `main()` del script, así que la única forma de refrescar el
 * gasto era esperar el cron. El gasto de hoy cambia todo el tiempo y las ventas
 * se ven en vivo (las escribe el webhook y la página lee la base en cada
 * request): tener una mitad del ROI al día y la otra de hace 50 minutos hace que
 * el número no se pueda usar para decidir si cortar una campaña.
 *
 * IDEMPOTENTE A PROPÓSITO
 * El upsert matchea (platform, account_id, day, level, campaign_id, adset_id,
 * ad_id), así que llamarlo dos veces con el mismo rango no duplica nada: pisa
 * los mismos valores. Eso es lo que permite llamarlo desde el render sin
 * coordinar con el cron.
 */

import { q, tx } from '../db';
import { fetchInsights, listAccounts, MetaAdsError, type MetaInsightRow } from './meta';
import { getRate } from '../fx';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

export type CuentaSync = {
  accountId: string;
  funnelId: number | null;
  currency: string | null;
  name: string | null;
};

export type ResultadoCuenta = {
  accountId: string;
  name: string | null;
  funnelId: number | null;
  currency: string;
  /** Filas con gasto, impresiones o video > 0 que trajo Meta (R7 c13). */
  filas: number;
  total: number;
  error: string | null;
};

export type ResultadoSync = {
  from: string;
  to: string;
  filas: number;
  cuentas: ResultadoCuenta[];
};

/** Las cuentas activas que hay que sincronizar. */
export async function cuentasActivas(): Promise<CuentaSync[]> {
  return q<CuentaSync>(
    `SELECT account_id AS "accountId", funnel_id AS "funnelId", currency, name
     FROM ad_accounts WHERE active AND platform = 'meta' ORDER BY account_id`,
  );
}

/**
 * Refresca nombre, moneda y zona horaria de las cuentas desde Meta.
 *
 * La zona es el dato que define el corte de `ad_spend.day`: Meta reporta los
 * días en la zona de la CUENTA, no en la de la tienda. Si el usuario la cambia
 * en el administrador de anuncios, todo el gasto que entre después cambia de
 * corte y el panel tiene que poder avisarlo.
 *
 * Best-effort: si el token no puede leer los metadatos, el gasto (que es lo que
 * importa) se sincroniza igual.
 */
export async function refrescarMetadatosCuentas(): Promise<string | null> {
  try {
    const meta = await listAccounts();
    for (const m of meta) {
      if (!m.timezone) continue;
      await q(
        `UPDATE ad_accounts SET timezone = $2
         WHERE account_id = $1 AND timezone IS DISTINCT FROM $2`,
        [m.accountId, m.timezone],
      );
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Una fila de Insights es relevante si gastó, se mostró o tuvo video (R7 c13):
 * un anuncio que se vio y no gastó tiene que guardarse igual, o sus
 * Metricas_Creativo quedan incompletas.
 */
function filaRelevante(f: MetaInsightRow): boolean {
  return (
    f.spend > 0 ||
    f.impressions > 0 ||
    f.videoReproducciones !== null ||
    f.videoThruplay !== null ||
    f.videoP25 !== null ||
    f.videoP50 !== null ||
    f.videoP75 !== null ||
    f.videoP100 !== null
  );
}

const TIMEOUT = Symbol('timeout');

/**
 * Corre `p` con un presupuesto de tiempo; si se pasa devuelve TIMEOUT sin
 * rechazar (el promise de fondo sigue y su rechazo queda manejado por el race).
 */
async function conTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let alarma: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMEOUT>((resolve) => {
        alarma = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    if (alarma) clearTimeout(alarma);
  }
}

/**
 * La lectura de Insights con el reintento degradado de R7 c11: si el pedido con
 * los campos nuevos falla o pasa de 30 s, se reintenta UNA sola vez pidiendo
 * únicamente gasto, impresiones y clics. Devuelve si la lectura final fue
 * degradada, para que el resultado lo diga.
 */
async function leerInsights(
  accountId: string,
  from: string,
  to: string,
): Promise<{ filas: MetaInsightRow[]; degradado: boolean }> {
  // R7 c11: un fallo del pedido con los campos nuevos (o sus 30 s vencidos)
  // dispara UNA sola reintentada pidiendo únicamente gasto, impresiones y clics.
  let primera: MetaInsightRow[] | typeof TIMEOUT;
  try {
    primera = await conTimeout(fetchInsights(accountId, from, to), 30_000);
  } catch {
    primera = TIMEOUT;
  }
  if (primera !== TIMEOUT) return { filas: primera, degradado: false };

  const basica = await conTimeout(fetchInsights(accountId, from, to, true), 30_000);
  if (basica === TIMEOUT) {
    throw new MetaAdsError('la lectura de Insights excedió 30 s también en el reintento degradado');
  }
  return { filas: basica, degradado: true };
}

/**
 * Trae el gasto de `from`..`to` y lo guarda. Una cuenta que falla no detiene a
 * las otras: el error se guarda en `ad_accounts.last_sync_error` para que
 * /config lo muestre sin entrar por SSH, y se devuelve en el resultado.
 */
export async function syncAdSpend(opts: {
  from: string;
  to: string;
  dryRun?: boolean;
  cuentas?: CuentaSync[];
}): Promise<ResultadoSync> {
  const { from, to } = opts;
  const dryRun = opts.dryRun ?? false;
  const cuentas = opts.cuentas ?? (await cuentasActivas());

  const out: ResultadoSync = { from, to, filas: 0, cuentas: [] };

  for (const c of cuentas) {
    const moneda = c.currency ?? 'ARS';
    try {
      const { filas, degradado } = await leerInsights(c.accountId, from, to);
      const relevantes = filas.filter(filaRelevante);
      const total = relevantes.reduce((a, f) => a + f.spend, 0);

      out.cuentas.push({
        accountId: c.accountId,
        name: c.name,
        funnelId: c.funnelId,
        currency: moneda,
        filas: relevantes.length,
        total,
        error: null,
      });
      out.filas += relevantes.length;

      if (dryRun) continue;

      // ┌───────────────────────────────────────────────────────────────────────┐
      // │ CERO FILAS ES UNA CORRIDA EXITOSA Y SE MARCA COMO TAL.                │
      // └───────────────────────────────────────────────────────────────────────┘
      // Hasta el 2026-09-02 este `continue` estaba pegado al de `dryRun`, así que
      // una cuenta sin gasto se iba de la iteración ANTES del UPDATE de
      // `last_sync_at` / `last_sync_error` que está al final del `tx` de abajo.
      // Consecuencia: la cuenta quedaba congelada en el último instante en que
      // tuvo filas o falló, y un `last_sync_error` viejo NO SE LIMPIABA NUNCA.
      //
      // Lo que se veía en producción: la cuenta «Protocolo reset», sin gasto
      // desde el 2026-08-26, tuvo un `TypeError: fetch failed` transitorio a las
      // 14:27:38 del 2026-09-01. Las corridas siguientes anduvieron perfecto y
      // devolvieron cero filas, así que el panel siguió mostrando ese error 10
      // horas después, con una frescura de 10 horas para un sync que estaba
      // corriendo cada hora sin problemas.
      //
      // Y el daño no era sólo cosmético: las dos puertas de frescura del módulo
      // (`live.ts` y `refrescarGasto` en `run-ad-rules.ts`) miran
      // `min(last_sync_at)` de TODAS las cuentas activas, a propósito, para que un
      // fallo no se vea como un dato fresco. Con una cuenta clavada en el pasado
      // ese mínimo nunca sube, el TTL de insights queda permanentemente vencido y
      // cada carga del panel dispara un `syncAdSpend` completo contra Meta.
      //
      // La jerarquía ya tenía esto bien: `anotarCorrida` se llama en un punto
      // donde convergen TODOS los desenlaces, y por eso
      // `last_hierarchy_sync_at` sí estaba al día. Esto lo alinea.
      if (relevantes.length === 0) {
        await q(
          `UPDATE ad_accounts SET last_sync_at = now(), last_sync_error = NULL WHERE account_id = $1`,
          [c.accountId],
        );
        continue;
      }

      // La cotización se resuelve por día, una vez por día y no por fila.
      const rates = new Map<string, number | null>();
      const rateDe = async (day: string, currency: string): Promise<number | null> => {
        const k = `${day}:${currency}`;
        if (rates.has(k)) return rates.get(k) ?? null;
        if (currency === MONEDA_REPORTE) {
          rates.set(k, 1);
          return 1;
        }
        const fx = await getRate(day, currency, MONEDA_REPORTE);
        rates.set(k, fx?.rate ?? null);
        return fx?.rate ?? null;
      };

      // Un solo upsert por cuenta con arrays: una cuenta con 300 anuncios × 2
      // días son 600 filas, y de a una serían 600 round-trips.
      const cols: {
        day: string[]; campaignId: string[]; campaignName: (string | null)[];
        adsetId: string[]; adsetName: (string | null)[];
        adId: string[]; adName: (string | null)[];
        spend: number[]; spendEur: (number | null)[]; rate: (number | null)[];
        impressions: number[]; clicks: number[];
        videoPlays: (number | null)[]; videoThruplay: (number | null)[];
        videoP25: (number | null)[]; videoP50: (number | null)[];
        videoP75: (number | null)[]; videoP100: (number | null)[];
      } = {
        day: [], campaignId: [], campaignName: [], adsetId: [], adsetName: [],
        adId: [], adName: [], spend: [], spendEur: [], rate: [], impressions: [], clicks: [],
        videoPlays: [], videoThruplay: [], videoP25: [], videoP50: [], videoP75: [], videoP100: [],
      };

      for (const f of relevantes) {
        const rate = await rateDe(f.date, moneda);
        cols.day.push(f.date);
        cols.campaignId.push(f.campaignId);
        cols.campaignName.push(f.campaignName);
        cols.adsetId.push(f.adsetId);
        cols.adsetName.push(f.adsetName);
        cols.adId.push(f.adId);
        cols.adName.push(f.adName);
        cols.spend.push(f.spend);
        cols.spendEur.push(rate === null ? null : Math.round(f.spend * rate * 100) / 100);
        cols.rate.push(rate);
        cols.impressions.push(f.impressions);
        cols.clicks.push(f.clicks);
        cols.videoPlays.push(f.videoReproducciones);
        cols.videoThruplay.push(f.videoThruplay);
        cols.videoP25.push(f.videoP25);
        cols.videoP50.push(f.videoP50);
        cols.videoP75.push(f.videoP75);
        cols.videoP100.push(f.videoP100);
      }

      await tx(async (cl) => {
        await cl.query(
          `INSERT INTO ad_spend (platform, account_id, funnel_id, day, level,
                                 campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
                                 spend, currency, spend_eur, fx_rate, impressions, clicks,
                                 video_plays, video_thruplay, video_p25, video_p50, video_p75, video_p100,
                                 synced_at)
           SELECT 'meta', $1, $2::smallint, u.day, 'ad',
                  u.campaign_id, u.campaign_name, u.adset_id, u.adset_name, u.ad_id, u.ad_name,
                  u.spend, $3, u.spend_eur, u.rate, u.impressions, u.clicks,
                  u.video_plays, u.video_thruplay, u.video_p25, u.video_p50, u.video_p75, u.video_p100,
                  now()
           FROM UNNEST($4::date[], $5::text[], $6::text[], $7::text[], $8::text[],
                       $9::text[], $10::text[], $11::numeric[], $12::numeric[], $13::numeric[],
                       $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[], $18::bigint[],
                       $19::bigint[], $20::bigint[], $21::bigint[])
                AS u(day, campaign_id, campaign_name, adset_id, adset_name,
                     ad_id, ad_name, spend, spend_eur, rate, impressions, clicks,
                     video_plays, video_thruplay, video_p25, video_p50, video_p75, video_p100)
           ON CONFLICT (platform, account_id, day, level, campaign_id, adset_id, ad_id)
           DO UPDATE SET
             spend = EXCLUDED.spend,
             spend_eur = EXCLUDED.spend_eur,
             fx_rate = EXCLUDED.fx_rate,
             impressions = EXCLUDED.impressions,
             clicks = EXCLUDED.clicks,
             video_plays = EXCLUDED.video_plays,
             video_thruplay = EXCLUDED.video_thruplay,
             video_p25 = EXCLUDED.video_p25,
             video_p50 = EXCLUDED.video_p50,
             video_p75 = EXCLUDED.video_p75,
             video_p100 = EXCLUDED.video_p100,
             campaign_name = EXCLUDED.campaign_name,
             adset_name = EXCLUDED.adset_name,
             ad_name = EXCLUDED.ad_name,
             funnel_id = EXCLUDED.funnel_id,
             currency = EXCLUDED.currency,
             synced_at = now()`,
          [
            c.accountId, c.funnelId, moneda,
            cols.day, cols.campaignId, cols.campaignName, cols.adsetId, cols.adsetName,
            cols.adId, cols.adName, cols.spend, cols.spendEur, cols.rate,
            cols.impressions, cols.clicks,
            cols.videoPlays, cols.videoThruplay, cols.videoP25, cols.videoP50, cols.videoP75, cols.videoP100,
          ],
        );
        await cl.query(
          `UPDATE ad_accounts SET last_sync_at = now(), last_sync_error = NULL WHERE account_id = $1`,
          [c.accountId],
        );
      });

      if (degradado) {
        console.warn(`ads sync: la cuenta ${c.accountId} guardó solo gasto, impresiones y clics (reintento degradado de R7 c11): las columnas de video quedaron en NULL`);
      }
    } catch (e) {
      const msg = e instanceof MetaAdsError ? `${e.message} (code ${e.code ?? '-'})` : String(e);
      out.cuentas.push({
        accountId: c.accountId,
        name: c.name,
        funnelId: c.funnelId,
        currency: moneda,
        filas: 0,
        total: 0,
        error: msg,
      });
      await q(
        'UPDATE ad_accounts SET last_sync_at = now(), last_sync_error = $2 WHERE account_id = $1',
        [c.accountId, msg.slice(0, 500)],
      );
    }
  }

  return out;
}
