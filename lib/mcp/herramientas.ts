/**
 * Las herramientas del MCP de anuncios (server-only). TODAS SON DE LECTURA:
 * consultas SELECT a la base y GETs a Meta (`fetchCreativo`). No hay ninguna que
 * escriba, y agregar una acá es la única forma de que el MCP pueda hacerlo.
 *
 * Los números salen de `getMetricasAds`, la misma consulta de la pantalla de
 * Anuncios: lo que lee la IA es lo que ve el dueño en el panel.
 *
 *  · listar_funnels  → los funnels y sus cuentas publicitarias.
 *  · anuncios        → los anuncios de un funnel en un rango, sólo los que
 *                      tienen gasto o ventas.
 *  · links_creativos → el link de descarga del video/imagen y el copy.
 *
 * Elegir los ganadores lo hace la IA que usa el MCP, a propósito: el criterio
 * cambia según para qué se los quiere, y no vive acá.
 */

import { q } from '../db';
import { today } from '../day';
import { ensureFreshAdSpend } from '../ads/live';
import { fetchCreativo, MetaAdsError } from '../ads/meta';
import { resolverRangoCustom } from '../ads/rangoCustom';
import { TZ_DEFAULT } from '../ads/zona';
import { getMetricasAds, primerDiaConVentas } from '../queries/ads';
import { ErrorHerramienta, type Herramienta } from './protocolo';

type Cuenta = { accountId: string; nombre: string; tz: string };
type Funnel = { id: number; slug: string; nombre: string };

const r2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

async function funnels(): Promise<Funnel[]> {
  return q<Funnel>(`SELECT id, slug, name AS nombre FROM funnels ORDER BY id`);
}

/**
 * Las cuentas donde un funnel tiene anuncios: la cuenta que es suya y las que
 * tienen campañas mapeadas a él (las «arroz» de Chau Hinchazón viven en
 * HIlvanapp, que es la cuenta de Alma Gemela).
 */
async function cuentasDe(funnelId: number): Promise<Cuenta[]> {
  return q<Cuenta>(
    `SELECT a.account_id AS "accountId", a.name AS nombre, COALESCE(a.timezone, $2) AS tz
       FROM ad_accounts a
      WHERE a.active AND a.platform = 'meta'
        AND (a.funnel_id = $1
             OR EXISTS (SELECT 1 FROM ad_campaign_funnel m
                         WHERE m.account_id = a.account_id AND m.funnel_id = $1))
      ORDER BY a.account_id`,
    [funnelId, TZ_DEFAULT],
  );
}

const listarFunnels: Herramienta = {
  name: 'listar_funnels',
  description:
    'Lista los funnels (embudos de venta) del panel con su slug y las cuentas publicitarias de Meta ' +
    'donde tienen anuncios. Usá el slug en `anuncios`.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => {
    const lista = await funnels();
    return Promise.all(
      lista.map(async (f) => ({
        slug: f.slug,
        nombre: f.nombre,
        cuentas: (await cuentasDe(f.id)).map((c) => ({ cuenta: c.nombre, zona_horaria: c.tz })),
      })),
    );
  },
};

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 92;

function restarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const anuncios: Herramienta = {
  name: 'anuncios',
  description:
    'Los anuncios de un funnel en un rango de fechas, con gasto, ventas reales, neto, ganancia, ROI, ' +
    'ROAS, CPA, CTR, CPM, hook rate y thruplays. Sólo trae anuncios con gasto o ventas en el rango. ' +
    'El rango es por `desde`/`hasta` (YYYY-MM-DD, inclusive) o por `dias` (los últimos N días ' +
    'contando hoy: 1 = hoy, 7 = la última semana). Los días son los de la zona horaria de cada ' +
    'cuenta. Importes en EUR. ROI = neto ÷ gasto (1 = empate).',
  inputSchema: {
    type: 'object',
    properties: {
      funnel: { type: 'string', description: 'slug del funnel (ver listar_funnels)' },
      desde: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      hasta: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      dias: { type: 'integer', minimum: 1, maximum: MAX_DIAS, description: 'alternativa a desde/hasta' },
    },
    required: ['funnel'],
    additionalProperties: false,
  },
  run: async (args) => {
    const slug = String(args.funnel ?? '').trim();
    const f = (await funnels()).find((x) => x.slug === slug);
    if (!f) throw new ErrorHerramienta(`no existe el funnel '${slug}'. Usá listar_funnels para ver los slugs.`);

    const cuentas = await cuentasDe(f.id);
    if (cuentas.length === 0) return { funnel: f.slug, anuncios: [], nota: 'este funnel no tiene cuentas publicitarias activas' };

    const filas = [];
    let rangoUsado: { desde: string; hasta: string } | null = null;

    for (const c of cuentas) {
      const hoy = await today(c.tz);
      let desde: string;
      let hasta: string;
      if (args.dias !== undefined) {
        const n = Number(args.dias);
        if (!Number.isInteger(n) || n < 1 || n > MAX_DIAS) throw new ErrorHerramienta(`dias tiene que ser un entero entre 1 y ${MAX_DIAS}`);
        desde = restarDias(hoy, n - 1);
        hasta = hoy;
      } else {
        desde = String(args.desde ?? '');
        hasta = String(args.hasta ?? '');
        if (!DIA.test(desde) || !DIA.test(hasta)) throw new ErrorHerramienta('pasá `dias`, o `desde` y `hasta` como YYYY-MM-DD');
        if (desde > hasta) throw new ErrorHerramienta('`desde` es posterior a `hasta`');
        if (restarDias(hasta, MAX_DIAS - 1) > desde) throw new ErrorHerramienta(`el rango no puede pasar de ${MAX_DIAS} días`);
      }
      const rango = resolverRangoCustom(desde, hasta, hoy, await primerDiaConVentas(c.tz));
      if (!rango) throw new ErrorHerramienta(`no hay datos en ese rango (hoy es ${hoy} en ${c.tz})`);
      rangoUsado = rango;

      // Si el rango incluye hoy, el gasto de hoy se trae de Meta antes de leer
      // (igual que la pantalla). Con tope: si Meta tarda, se lee lo guardado.
      if (rango.hasta === hoy) await ensureFreshAdSpend(hoy, hoy, { timeoutMs: 15_000 }).catch(() => null);

      for (let page = 1; page <= 10; page++) {
        const r = await getMetricasAds({
          level: 'ad',
          period: 'today',
          desde: rango.desde,
          hasta: rango.hasta,
          accountIds: [c.accountId],
          ocultarSinDatos: true,
          limit: 1000,
          page,
        });
        for (const x of r.filas) if (x.funnelId === f.id) filas.push({ cuenta: c.nombre, x });
        if (!r.hayMas) break;
      }
    }

    // Nombres de campaña y conjunto, que la fila de nivel anuncio no trae.
    const ids = [...new Set(filas.flatMap(({ x }) => [x.campaignId, x.adsetId]))];
    const nombres = new Map(
      (
        await q<{ id: string; name: string | null }>(
          `SELECT campaign_id AS id, name FROM ad_campaigns WHERE campaign_id = ANY($1::text[])
           UNION ALL
           SELECT adset_id, name FROM ad_sets WHERE adset_id = ANY($1::text[])`,
          [ids],
        )
      ).map((n) => [n.id, n.name]),
    );

    const lista = filas
      .map(({ cuenta, x }) => ({
        ad_id: x.adId,
        anuncio: x.objectName,
        conjunto: nombres.get(x.adsetId) ?? null,
        campana: nombres.get(x.campaignId) ?? null,
        cuenta,
        estado: x.effectiveStatus,
        gasto: r2(x.spendEur),
        ventas: x.sales,
        ingresos: r2(x.revenueEur),
        neto: r2(x.netEur),
        ganancia: r2(x.profitEur),
        roi: r2(x.roi),
        roas: r2(x.roas),
        cpa: r2(x.cpaEur),
        impresiones: x.impressions,
        clics: x.clicks,
        ctr_pct: x.ctr === null ? null : r2(x.ctr * 100),
        cpm: r2(x.cpmEur),
        hook_rate_pct: x.hookRate === null ? null : r2(x.hookRate * 100),
        thruplays: x.videoThruplay,
      }))
      .sort((a, b) => (b.gasto ?? 0) - (a.gasto ?? 0));

    return {
      funnel: f.slug,
      rango: rangoUsado,
      moneda: 'EUR',
      cantidad: lista.length,
      anuncios: lista,
    };
  },
};

const MAX_CREATIVOS = 20;

const linksCreativos: Herramienta = {
  name: 'links_creativos',
  description:
    `El creativo de hasta ${MAX_CREATIVOS} anuncios (por ad_id, de \`anuncios\`): tipo (video/imagen), link ` +
    'directo de descarga del archivo original, copy, título, botón y link de destino. Los links son de ' +
    'Meta, firmados, y VENCEN en unas horas: descargalos enseguida (un GET al link baja el archivo).',
  inputSchema: {
    type: 'object',
    properties: {
      ad_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_CREATIVOS },
    },
    required: ['ad_ids'],
    additionalProperties: false,
  },
  run: async (args) => {
    const ids = Array.isArray(args.ad_ids) ? [...new Set(args.ad_ids.map(String))] : [];
    if (ids.length === 0 || ids.length > MAX_CREATIVOS) {
      throw new ErrorHerramienta(`pasá entre 1 y ${MAX_CREATIVOS} ad_ids`);
    }
    const filas = await q<{ ad_id: string; account_id: string; name: string | null }>(
      `SELECT ad_id, account_id, name FROM ads WHERE ad_id = ANY($1::text[])`,
      [ids],
    );
    const porId = new Map(filas.map((f) => [f.ad_id, f]));

    // De a 4 por vez: son 1–3 GETs a Meta por anuncio y la cuenta tiene cupo.
    const salida: unknown[] = [];
    for (let i = 0; i < ids.length; i += 4) {
      const tanda = ids.slice(i, i + 4);
      salida.push(
        ...(await Promise.all(
          tanda.map(async (id) => {
            const ad = porId.get(id);
            if (!ad) return { ad_id: id, error: 'no existe ese anuncio en el panel' };
            try {
              const c = await fetchCreativo(id, ad.account_id);
              if (!c) return { ad_id: id, anuncio: ad.name, error: 'Meta no devolvió creativo' };
              const descarga = c.tipo === 'video' ? c.videoUrl : c.imagenUrl;
              return {
                ad_id: id,
                anuncio: ad.name,
                tipo: c.tipo,
                link_descarga: descarga,
                miniatura: c.tipo === 'video' ? c.imagenUrl : null,
                texto: c.texto,
                titulo: c.titulo,
                boton: c.cta,
                destino: c.link,
                ...(descarga ? {} : { error: 'Meta no da el archivo original de este anuncio (sólo la vista previa)' }),
              };
            } catch (e) {
              return { ad_id: id, anuncio: ad.name, error: e instanceof MetaAdsError ? e.message : 'error pidiendo el creativo a Meta' };
            }
          }),
        )),
      );
    }
    return { nota: 'los links vencen en unas horas', creativos: salida };
  },
};

export const HERRAMIENTAS: Herramienta[] = [listarFunnels, anuncios, linksCreativos];
