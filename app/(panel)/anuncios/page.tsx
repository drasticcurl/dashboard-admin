/**
 * /anuncios — el gestor de campañas, conjuntos y anuncios (T17 §1), ahora
 * Gestor_Anuncios (gestion-campanas-anuncios, task 20.4).
 *
 * Server component: lee las cuentas activas, resuelve los filtros del query
 * string (con default a la primera cuenta activa para no disparar `zonas_horarias
 * mezcladas`, P-A03) y hace el fetch inicial acá para que la primera pintura ya
 * tenga datos. Los cambios de filtro los maneja GestorAnuncios en el client.
 *
 * LA CUENTA LA MANDA EL FUNNEL, y no se elige acá. Es la imputada al funnel del
 * selector de arriba (`?f=`), y cuando no hay `?f=` es la del PRIMER funnel, que
 * es el que `Nav.tsx` muestra como elegido en ese caso: si acá se resolviera por
 * cuenta, el selector diría una cosa y la tabla mostraría otra.
 *
 * Un `?account=` en la URL se ignora: ya no es un control. Y el aviso de cuenta
 * desalineada desapareció porque con la cuenta derivada del funnel no puede
 * haber divergencia.
 *
 * La Vista_Por_Defecto se lee acá y llega como prop en el PRIMER render, así se
 * aplica en 2 segundos o menos sin salto visual entre las doce columnas base y
 * la Vista (R3 c8). El nivel por defecto es «Campañas» (R1 c13).
 */

import { q, q1 } from '@/lib/db';
import { getMetricasAds } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import type { FrescuraJerarquia } from '@/lib/ads/liveJerarquia';
import { today } from '@/lib/day';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import { listFunnels, nombreVisible } from '@/lib/funnels';
import { parseRepoVistas } from '@/lib/ads/vistas';
import type { Vista } from '@/lib/ads/vistas';
import { EmptyState } from '@/components/ui';
import { GestorAnuncios } from './GestorAnuncios';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function lista(v: string | string[] | undefined): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  return [];
}

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAds[] = ['today', 'yesterday', '7d', '7d_excl_today'];
const MAX_CASCADA = 50;

export type CuentaAds = {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** El funnel al que se le imputa el gasto (`ad_accounts.funnel_id`). */
  funnelSlug: string | null;
  funnelName: string | null;
};

const LIMPIAR_IDS = (ids: string[]): string[] => {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= MAX_CASCADA) break;
    if (!/^\d{1,20}$/.test(id) || vistos.has(id)) continue;
    vistos.add(id);
    out.push(id);
  }
  return out;
};

export default async function AnunciosPage({ searchParams }: { searchParams: SearchParams }) {
  const cuentas = await q<CuentaAds>(
    `SELECT a.account_id AS "accountId", a.name, a.currency, a.timezone,
            f.slug AS "funnelSlug", f.name AS "funnelName"
       FROM ad_accounts a
       LEFT JOIN funnels f ON f.id = a.funnel_id
      WHERE a.active AND a.platform = 'meta'
      ORDER BY a.account_id`,
  );

  const nivel = (NIVELES.includes(single(searchParams.level) as NivelAds)
    ? (single(searchParams.level) as NivelAds)
    : 'campaign') as NivelAds;
  const period = (PERIODOS.includes(single(searchParams.period) as PeriodoAds)
    ? (single(searchParams.period) as PeriodoAds)
    : 'today') as PeriodoAds;
  const status = (['active', 'paused', 'any'].includes(single(searchParams.status) ?? '')
    ? (single(searchParams.status) as 'active' | 'paused' | 'any')
    : 'any') as 'active' | 'paused' | 'any';

  // ── La cuenta la determina el funnel de arriba, no se elige acá ──
  const funnels = await listFunnels();
  const funnelSlug = single(searchParams.f);
  // Sin `?f=`, `Nav.tsx` pinta `funnels[0]` como elegido: se resuelve igual para
  // que el selector y la tabla nunca muestren cosas distintas.
  const funnelActivo =
    (funnelSlug ? funnels.find((f) => f.slug === funnelSlug) : undefined) ?? funnels[0];

  if (!funnelActivo) {
    return (
      <EmptyState
        title="No hay funnels activos"
        hint="Creá uno en Config → Funnels para poder ver sus campañas."
      />
    );
  }

  const cuentaActual = cuentas.find((c) => c.funnelSlug === funnelActivo.slug);
  if (!cuentaActual) {
    return (
      <EmptyState
        title={`«${nombreVisible(funnelActivo)}» no tiene cuenta publicitaria imputada`}
        hint="La cuenta que se muestra acá la determina el funnel elegido arriba. Imputale una en Config → Publicidad, o cambiá de funnel en el selector de arriba."
      />
    );
  }
  const account = cuentaActual.accountId;

  const nombre = single(searchParams.nombre);
  // Se leen como "=0" para que la AUSENCIA signifique "mostrar todo", que es el
  // comportamiento de siempre y el que no sorprende al abrir la pantalla.
  const ocultarSinDatos = single(searchParams.sinDatos) === '0';
  const ocultarPadreApagado = single(searchParams.padreApagado) === '0';

  // ── Filtro_Cascada de la URL (R8 c7, c13): la tabla abre ya filtrada ──
  const campaignIds = nivel === 'adset' || nivel === 'ad' ? LIMPIAR_IDS(lista(searchParams.campaignIds)) : [];
  const adsetIds = nivel === 'ad' ? LIMPIAR_IDS(lista(searchParams.adsetIds)) : [];

  let data;
  try {
    data = await getMetricasAds({
      level: nivel,
      period,
      accountIds: account ? [account] : undefined,
      status,
      nombre,
      campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
      adsetIds: adsetIds.length > 0 ? adsetIds : undefined,
      ocultarSinDatos,
      ocultarPadreApagado,
    });
  } catch (e) {
    return (
      <EmptyState
        title="No se pudo cargar la tabla"
        hint={e instanceof Error ? e.message : String(e)}
      />
    );
  }

  const hoy = await today(data.rango.timezone);
  const adsFreshness = await ensureFreshAdSpend(data.rango.to, hoy);

  // ── Los settings del primer render y la antigüedad de la Jerarquía ──
  //
  // Los settings son la Vista_Por_Defecto (R3 c8) y el umbral de
  // Frescura_Objeto (task 7.3). Van acá porque el efecto del cliente NO corre en
  // el primer render: sin el umbral, la primera pintura marcaría filas viejas
  // contra un default y las marcas cambiarían solas al primer cambio de filtro.
  //
  // La edad de la Jerarquía va por lo mismo, y con un motivo más fuerte: la barra
  // la muestra aparte de la del gasto (R4.5, task 11), pero el cliente sólo la
  // recibe en las respuestas con `forzar`, o sea únicamente cuando el usuario
  // aprieta Actualizar. Sin este valor la barra no tendría nada que decir de la
  // Jerarquía hasta ese click, y el número quedaría invisible exactamente
  // mientras nadie lo fuerza —que es cuando puede estar atrasado hasta 15
  // minutos, el intervalo del cron, y cuando hay que poder verlo—.
  //
  // Se LEE, no se sincroniza. `ensureFreshJerarquia` acá dispararía una
  // Sync_Jerarquia (cuatro llamadas a Meta por cuenta) en cada apertura de la
  // pantalla, y el diseño le dejó un único disparador, el Boton_Actualizar
  // (R4.8). El SQL es el de `leerFrescura` de lib/ads/liveJerarquia.ts —misma
  // fila, mismo filtro por cuenta activa de Meta, y la edad calculada por
  // Postgres y no por el reloj del navegador— porque ese módulo no exporta la
  // lectura sin el sync.
  //
  // Las dos consultas en la misma vuelta: son independientes y en serie sólo
  // sumarían latencia al primer render.
  const [ajustes, jerarquia] = await Promise.all([
    q1<{ vistas: unknown; umbral: unknown }>(
      `SELECT (SELECT value FROM settings WHERE key = 'ads_vistas') AS "vistas",
              (SELECT value FROM settings WHERE key = 'ads_frescura_umbral_segundos') AS "umbral"`,
    ),
    q1<{ syncedAt: string | null; age: string | null; err: string | null }>(
      `SELECT last_hierarchy_sync_at::text AS "syncedAt",
              EXTRACT(EPOCH FROM (now() - last_hierarchy_sync_at))::text AS age,
              last_hierarchy_sync_error AS err
         FROM ad_accounts
        WHERE account_id = $1 AND active AND platform = 'meta'`,
      [account],
    ),
  ]);

  // `refreshed: false` porque este render no fue a Meta: es lo que distingue esta
  // frescura de la que devuelve el endpoint cuando el botón la fuerza. Sin fila o
  // sin reloj escrito, `ageSeconds` queda en `null` y la barra dice "nunca
  // sincronizado", que es lo que pasa hasta la primera corrida del cron.
  const jerarquiaFreshness: FrescuraJerarquia = {
    syncedAt: jerarquia?.syncedAt ?? null,
    ageSeconds:
      jerarquia?.syncedAt != null && jerarquia.age != null
        ? Math.round(Number(jerarquia.age))
        : null,
    refreshed: false,
    error: jerarquia?.err ?? null,
  };

  let vistaPorDefecto: Vista | null = null;
  if (ajustes && ajustes.vistas !== null && ajustes.vistas !== undefined) {
    const repo = parseRepoVistas(ajustes.vistas);
    if (repo?.porDefecto) {
      vistaPorDefecto = repo.vistas.find((v) => v.id === repo.porDefecto) ?? null;
    }
  }

  // `settings.value` es jsonb: si no hay número, el default es el mismo 900 que
  // seedeó la 025.
  const frescuraUmbralSegundos = typeof ajustes?.umbral === 'number' ? ajustes.umbral : 900;

  // ── Nombres de los ids de la cascada, para el ChipCascada (R8 c4) ──
  const idsCascada = nivel === 'adset' || nivel === 'ad' ? campaignIds : [];
  const nombresCascada: Record<string, string> = {};
  if (idsCascada.length > 0) {
    const filas = await q<{ id: string; name: string | null }>(
      `SELECT campaign_id AS id, name FROM ad_campaigns WHERE campaign_id = ANY($1::text[])`,
      [idsCascada],
    );
    for (const f of filas) if (f.name) nombresCascada[f.id] = f.name;
  }

  return (
    <GestorAnuncios
      cuentas={cuentas}
      initialData={data}
      adsFreshness={adsFreshness}
      jerarquiaFreshness={jerarquiaFreshness}
      nivelInicial={nivel}
      filtrosIniciales={{
        period,
        status,
        account,
        nombre,
        campaignIds,
        adsetIds,
        ocultarSinDatos,
        ocultarPadreApagado,
      }}
      vistaPorDefecto={vistaPorDefecto}
      nombresCascada={nombresCascada}
      frescuraUmbralSegundos={frescuraUmbralSegundos}
    />
  );
}
