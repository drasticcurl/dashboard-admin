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
import { fetchInsights, listAccounts, MetaAdsError } from './meta';
import { getRate } from '../fx';

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
  /** Filas con gasto > 0 que trajo Meta. */
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
      const filas = await fetchInsights(c.accountId, from, to);
      const conGasto = filas.filter((f) => f.spend > 0);
      const total = conGasto.reduce((a, f) => a + f.spend, 0);

      out.cuentas.push({
        accountId: c.accountId,
        name: c.name,
        funnelId: c.funnelId,
        currency: moneda,
        filas: conGasto.length,
        total,
        error: null,
      });
      out.filas += conGasto.length;

      if (dryRun || conGasto.length === 0) continue;

      // La cotización se resuelve por día, una vez por día y no por fila.
      const rates = new Map<string, number | null>();
      const rateDe = async (day: string, currency: string): Promise<number | null> => {
        const k = `${day}:${currency}`;
        if (rates.has(k)) return rates.get(k) ?? null;
        if (currency === 'EUR') {
          rates.set(k, 1);
          return 1;
        }
        const fx = await getRate(day, currency, 'EUR');
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
      } = {
        day: [], campaignId: [], campaignName: [], adsetId: [], adsetName: [],
        adId: [], adName: [], spend: [], spendEur: [], rate: [], impressions: [], clicks: [],
      };

      for (const f of conGasto) {
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
      }

      await tx(async (cl) => {
        await cl.query(
          `INSERT INTO ad_spend (platform, account_id, funnel_id, day, level,
                                 campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
                                 spend, currency, spend_eur, fx_rate, impressions, clicks, synced_at)
           SELECT 'meta', $1, $2::smallint, u.day, 'ad',
                  u.campaign_id, u.campaign_name, u.adset_id, u.adset_name, u.ad_id, u.ad_name,
                  u.spend, $3, u.spend_eur, u.rate, u.impressions, u.clicks, now()
           FROM UNNEST($4::date[], $5::text[], $6::text[], $7::text[], $8::text[],
                       $9::text[], $10::text[], $11::numeric[], $12::numeric[], $13::numeric[],
                       $14::bigint[], $15::bigint[])
                AS u(day, campaign_id, campaign_name, adset_id, adset_name,
                     ad_id, ad_name, spend, spend_eur, rate, impressions, clicks)
           ON CONFLICT (platform, account_id, day, level, campaign_id, adset_id, ad_id)
           DO UPDATE SET
             spend = EXCLUDED.spend,
             spend_eur = EXCLUDED.spend_eur,
             fx_rate = EXCLUDED.fx_rate,
             impressions = EXCLUDED.impressions,
             clicks = EXCLUDED.clicks,
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
          ],
        );
        await cl.query(
          `UPDATE ad_accounts SET last_sync_at = now(), last_sync_error = NULL WHERE account_id = $1`,
          [c.accountId],
        );
      });
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
