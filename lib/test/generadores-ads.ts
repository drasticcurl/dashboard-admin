/**
 * Generadores compartidos de property-based testing (task 2.1 de
 * gestion-campanas-anuncios). UN solo archivo a propósito: un generador
 * duplicado con otra distribución es cómo dos propiedades cubren lo mismo
 * creyendo cubrir cosas distintas (design §Testing Strategy).
 *
 * fast-check como devDependency con versión exacta (anexo D-05, decidido por el
 * usuario). No entra al bundle de producción: sólo corren en `npm test`.
 */

import fc from 'fast-check';
import type { ClaveOrden, Condicion, MetricasObjeto, NivelAds, PeriodoAds, Regla } from '../ads/tipos';
import { CATALOGO_METRICAS, type ColumnaVisible } from '../ads/catalogo';
import { motivoCondicionesImposibles } from '../ads/reglas/coherencia';
import type { Vista } from '../ads/vistas';
import type { EventoSeleccion } from '../ads/seleccion';

// ─── genMetricasObjeto ───────────────────────────────────────────────────────

const NIVELES_FC: readonly NivelAds[] = ['campaign', 'adset', 'ad'];

/** Números chicos: los empates son frecuentes, que es lo que las propiedades
 *  de orden (P5, P6) necesitan. */
const numChico = (min = 0, max = 6): fc.Arbitrary<number> => fc.integer({ min, max });
/** Nullable: las propiedades de orden necesitan nulos al final (R4 c6). */
const maybeNum = (min = 0, max = 6): fc.Arbitrary<number | null> =>
  fc.option(numChico(min, max), { nil: null });

/** ISO 8601 de una fecha al azar (fast-check 4 no trae iso8601Datetime). */
const isoDate: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2025-01-01T00:00:00Z'),
    max: new Date('2027-12-31T00:00:00Z'),
    noInvalidDate: true, // sin esto fc genera Date inválidos y toISOString tira
  })
  .map((d) => d.toISOString());

/**
 * Frescura_Objeto y marca de desaparición (spec frescura-y-acciones-anuncios,
 * R3.1). Los dos campos se generan JUNTOS porque no son independientes: un
 * objeto que Meta deja de devolver conserva el `syncedAt` de la última corrida
 * en que sí vino y recibe `desaparecidoAt` en una corrida POSTERIOR, así que
 * `desaparecidoAt > syncedAt` siempre. Generarlos por separado produciría
 * contraejemplos imposibles (desaparecido antes de haberse sincronizado) y las
 * propiedades de las tasks 8 y 15 fallarían por un dato que la base no puede
 * tener.
 *
 * El caso desaparecido sale ~1 de cada 4: bastante para que las propiedades que
 * lo consumen lo vean, sin volverlo el caso típico, que en la base no lo es.
 */
const genFrescura: fc.Arbitrary<{ syncedAt: string | null; desaparecidoAt: string | null }> = fc
  .tuple(
    fc.option(isoDate, { nil: null }),
    // Cuánto pasó entre el último sync confirmado y la corrida que lo marcó
    // ausente: de un minuto a treinta días. null = Meta lo sigue devolviendo.
    fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 30 * 24 * 3_600_000 }) },
    ),
  )
  .map(([syncedAt, desdeMs]) => ({
    syncedAt,
    desaparecidoAt:
      desdeMs === null
        ? null
        : // Sin `syncedAt` (objeto que nunca se confirmó) la marca igual existe:
          // se ancla en el extremo de la ventana de `isoDate`.
          new Date(
            (syncedAt === null ? Date.parse('2025-01-01T00:00:00Z') : Date.parse(syncedAt)) + desdeMs,
          ).toISOString(),
  }));

export function genMetricasObjeto(): fc.Arbitrary<MetricasObjeto> {
  return fc
    .tuple(
      fc.constantFrom(...NIVELES_FC),
      fc.uuid(),
      fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
      fc.uuid(),
      fc.constantFrom('ACTIVE', 'PAUSED', 'ARCHIVED', 'WITH_ISSUES', null),
      fc.constantFrom('ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', null),
      fc.constantFrom<'campaign' | 'adset' | null>('campaign', 'adset', null),
      fc.constantFrom<'daily' | 'lifetime' | null>('daily', 'lifetime', null),
      maybeNum(0, 50),
      numChico(0, 50),
      numChico(0, 50),
      numChico(0, 50),
      numChico(0, 20),
      numChico(0, 100),
      numChico(0, 10),
      numChico(0, 10),
      numChico(0, 10),
      numChico(0, 50), // netEur: suma, no cociente: nunca null
      numChico(0, 50), // profitEur: suma, nunca null
      maybeNum(0, 5),
      maybeNum(0, 5),
      maybeNum(0, 5),
      fc.option(isoDate, { nil: null }),
      maybeNum(0, 5),
      maybeNum(0, 5),
      maybeNum(0, 5),
      maybeNum(0, 5),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      maybeNum(0, 50),
      fc.option(isoDate, { nil: null }),
      genFrescura,
    )
    .map((t) => {
      const [
        level,
        objectId,
        objectName,
        accountId,
        status,
        effectiveStatus,
        budgetLevel,
        budgetMode,
        dailyBudgetEur,
        spendEur,
        impressions,
        clicks,
        sales,
        revenueEur,
        refundedEur,
        commissionsEur,
        costsEur,
        netEur,
        profitEur,
        roas,
        roi,
        cpaEur,
        ultimaAccionAt,
        ctr,
        cpcEur,
        cpmEur,
        hookRate,
        videoReproducciones,
        videoThruplay,
        videoP25,
        videoP50,
        videoP75,
        videoP100,
        alcance,
        frecuencia,
        inicioProgramado,
        frescura,
      ] = t;
      return {
        level,
        objectId,
        objectName,
        accountId,
        campaignId: level === 'campaign' ? objectId : `camp-${objectId}`,
        adsetId: level === 'campaign' ? '' : `set-${objectId}`,
        adId: level === 'ad' ? objectId : '',
        funnelId: null,
        status,
        effectiveStatus,
        budgetLevel,
        budgetMode,
        dailyBudgetEur,
        spendEur,
        impressions,
        clicks,
        sales,
        revenueEur,
        refundedEur,
        commissionsEur,
        costsEur,
        netEur,
        profitEur,
        roas,
        roi,
        cpaEur,
        ctr,
        cpcEur,
        ultimaAccionAt,
        cpmEur,
        hookRate,
        videoReproducciones,
        videoThruplay,
        videoP25,
        videoP50,
        videoP75,
        videoP100,
        alcance,
        frecuencia,
        inicioProgramado,
        syncedAt: frescura.syncedAt,
        desaparecidoAt: frescura.desaparecidoAt,
      };
    });
}

// ─── genColumnasVisibles / genVista ─────────────────────────────────────────

const CLAVES_NO_FIJAS: string[] = CATALOGO_METRICAS.filter((e) => !e.fija).map((e) => e.clave);
const CLAVES_ORDEN: string[] = CATALOGO_METRICAS.filter((e) => e.ordenable).map((e) => e.clave);
const ancho = (): fc.Arbitrary<number> => fc.integer({ min: 48, max: 640 });

/** Subconjunto al azar del catálogo con las dos Columna_Fija incluidas, más
 *  permutación, más anchos en 48..640. */
export function genColumnasVisibles(): fc.Arbitrary<ColumnaVisible[]> {
  return fc
    .shuffledSubarray(CLAVES_NO_FIJAS, { minLength: 0 })
    .chain((extra) =>
      fc
        .shuffledSubarray(['seleccion', 'nombre', ...extra], {
          minLength: extra.length + 2,
          maxLength: extra.length + 2,
        })
        .chain((perm) =>
          fc
            .array(ancho(), { minLength: perm.length, maxLength: perm.length })
            .map((anchos) => perm.map((clave, i) => ({ clave, ancho: anchos[i]! }))),
        ),
    );
}

/** Vista arbitraria: nombre 1..60 con espacios en los extremos, 1..27 claves
 *  sin repetir incluidas las fijas, anchos 48..640, Orden_Tabla con clave del
 *  catálogo. */
export function genVista(): fc.Arbitrary<Vista> {
  return fc
    .tuple(
      fc.uuid(),
      fc.string({ minLength: 1, maxLength: 56 }).map((s) => ` ${s.trim() || 'vista'} `),
      fc.constantFrom(...CLAVES_ORDEN),
      fc.constantFrom('asc', 'desc'),
    )
    .chain(([id, nombre, claveOrden, dir]) =>
      genColumnasVisibles().map((columnas) => ({
        id,
        nombre,
        columnas,
        orden: { clave: claveOrden as ClaveOrden, dir },
      })),
    );
}

// ─── genArbolAds ─────────────────────────────────────────────────────────────

export type NodoAnuncio = { adId: string; status: string };
export type NodoConjunto = {
  adsetId: string;
  campaignId: string;
  status: string;
  anuncios: NodoAnuncio[];
};
export type ArbolAds = {
  accountId: string;
  campanias: { campaignId: string; status: string; conjuntos: NodoConjunto[] }[];
};

const estadoMeta = (): fc.Arbitrary<string> =>
  fc.constantFrom('ACTIVE', 'PAUSED', 'WITH_ISSUES');

/** Árbol al azar: 1..5 campañas × 0..4 conjuntos × 0..6 anuncios, con estados
 *  al azar en cada nodo (P7, P11, P13). */
export function genArbolAds(): fc.Arbitrary<ArbolAds> {
  return fc.uuid().chain((accountId) =>
    fc
      .array(
        fc
          .record({ campaignId: fc.uuid(), status: estadoMeta() })
          .chain((camp) =>
            fc
              .array(
                fc
                  .record({
                    adsetId: fc.uuid(),
                    campaignId: fc.constant(camp.campaignId),
                    status: estadoMeta(),
                  })
                  .chain((set) =>
                    fc
                      .array(
                        fc.record({ adId: fc.uuid(), status: estadoMeta() }),
                        { minLength: 0, maxLength: 6 },
                      )
                      .map((anuncios) => ({ ...set, anuncios })),
                  ),
                { minLength: 0, maxLength: 4 },
              )
              .map((conjuntos) => ({ ...camp, conjuntos })),
          ),
        { minLength: 1, maxLength: 5 },
      )
      .map((campanias) => ({ accountId, campanias })),
  );
}

// ─── genNombreObjeto ─────────────────────────────────────────────────────────

/** Nombre de objeto de 1..400 caracteres, a veces ya terminando en sufijo de
 *  copia (« - Copia N»), que es el caso que recorta (R10 c6). */
export function genNombreObjeto(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string({ minLength: 1, maxLength: 400 }),
    fc
      .tuple(fc.string({ minLength: 1, maxLength: 380 }), fc.integer({ min: 1, max: 99 }))
      .map(([base, n]) => `${base} - Copia ${n}`),
  );
}

// ─── genRango ────────────────────────────────────────────────────────────────

/** Par (from, to) al azar con 0..6 días de largo, más un nivel. */
export function genRango(): fc.Arbitrary<{
  from: string;
  to: string;
  level: NivelAds;
}> {
  return fc
    .tuple(
      fc.date({
        min: new Date('2026-01-01T00:00:00Z'),
        max: new Date('2026-12-31T00:00:00Z'),
        noInvalidDate: true,
      }),
      fc.integer({ min: 0, max: 6 }),
      fc.constantFrom(...NIVELES_FC),
    )
    .map(([d, dias, level]) => {
      const from = d.toISOString().slice(0, 10);
      const to = new Date(d.getTime() + dias * 86_400_000).toISOString().slice(0, 10);
      return { from, to, level };
    });
}

// ─── genFechaHoraZona ────────────────────────────────────────────────────────

/** Zonas con y sin DST; las dos primeras con saltos de 1 hora en 2026. */
export const ZONAS_P16 = [
  'Europe/Lisbon',
  'America/New_York',
  'America/Argentina/Buenos_Aires',
  'Asia/Kolkata',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Fecha en un año calendario (cubre los dos saltos de DST) × hora 00:00..23:59
 *  × zona con y sin DST. Las horas exactas de los saltos caen solas. */
export function genFechaHoraZona(): fc.Arbitrary<{
  fecha: string;
  hora: string;
  zona: string;
}> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 364 }),
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      fc.constantFrom(...ZONAS_P16),
    )
    .map(([off, h, m, zona]) => {
      const d = new Date(Date.UTC(2026, 0, 1) + off * 86_400_000);
      return { fecha: d.toISOString().slice(0, 10), hora: `${pad2(h)}:${pad2(m)}`, zona };
    });
}

// ─── genNombreRegla / genRegla / genReglaPayload ─────────────────────────────
// Generadores de la spec reglas-anuncios-por-cuenta (task 2.1). Reutilizan lo
// que ya está arriba: genMetricasObjeto y ZONAS_P16. Un generador duplicado con
// otra distribución es cómo dos propiedades cubren lo mismo creyendo cubrir
// cosas distintas.

const horaMinuto = (): fc.Arbitrary<string> =>
  fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(
    ([h, m]) => `${pad2(h)}:${pad2(m)}`,
  );

const METRICAS_CONDICION: readonly Condicion['metric'][] = [
  'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
  'budget', 'impressions', 'clicks', 'ctr', 'cpc',
];
const OPS_CONDICION: readonly Condicion['op'][] = ['>', '>=', '<', '<=', '=', '!='];
const ACCIONES_REGLA: readonly Regla['action'][] = [
  'pause', 'activate', 'budget_increase', 'budget_decrease',
];

/** Nombre de regla de 1..200 caracteres con acentos, comillas y `$`, como los
 *  nombres reales del seed. Nunca queda vacío después de trim. */
export function genNombreRegla(): fc.Arbitrary<string> {
  const caracteres = [
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    ...' áéíóúñÁÉÍÓÚÑäöüç'.split(''),
    ...'\'"$%&()+-.,:!¿?'.split(''),
  ];
  return fc
    .integer({ min: 1, max: 200 })
    .chain((largo) =>
      fc
        .string({ minLength: largo, maxLength: largo, unit: fc.constantFrom(...caracteres) })
        .map((s) => s.trim() || 'regla'),
    );
}

/** Id de cuenta publicitaria con el prefijo `act_` de Meta, 5..64 caracteres.
 *  NUNCA queda vacío después de `btrim`: el CHECK `ad_rules_cuenta_no_vacia` de
 *  la 021 rechaza `' '`, y un generador que produce ids que la base rechaza no
 *  prueba el sistema, prueba el CHECK. */
const idCuenta = (): fc.Arbitrary<string> =>
  fc
    .string({
      minLength: 1,
      maxLength: 60,
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')),
    })
    .map((s) => `act_${s}`);

/** Una `Regla` completa y coherente con los CHECK de la `016`: si la acción es
 *  de presupuesto hay valor, unidad y el límite del lado correcto (techo para
 *  subir, piso para bajar, el factor en la dirección que la acción promete), la
 *  ventana va completa o vacía en 'HH:MM' y con las dos horas DISTINTAS, el
 *  estado del alcance es uno que la acción pueda tocar, y `accountId` nunca es
 *  vacío. Las tres últimas condiciones son las que verifica
 *  `lib/ads/reglas/coherencia`, el mismo módulo que usa el API.
 *
 *  RANGOS: `every_minutes`, `max_runs_per_day`, `cooldown_minutes` y
 *  `max_actions_per_object_per_day` son `smallint` en la 016 (tope 32767), y los
 *  cuatro tienen además un CHECK propio (cadencia 1..1440, cooldown >= 0, máximo
 *  por objeto >= 0 desde la 024, donde el 0 significa «sin tope»). Este
 *  generador arranca igual en 1 y no en 0: con 0 el freno no existe y las
 *  properties que necesitan verlo actuar no tendrían cómo. El 0 está cubierto
 *  por un ejemplo en motor.test.ts. Los límites de acá son los de esos CHECK, siempre por
 *  debajo del tope del tipo: un valor que la base rechaza con
 *  «out of range for type smallint» aborta la property antes de probar nada. */
export function genRegla(): fc.Arbitrary<Regla> {
  return fc
    .record({
      action: fc.constantFrom(...ACCIONES_REGLA),
      unit: fc.constantFrom<'percent' | 'fixed'>('percent', 'fixed'),
      valor: fc.integer({ min: 1, max: 400 }),
      alto: fc.integer({ min: 1, max: 200 }),
      bajo: fc.integer({ min: 1, max: 200 }),
    })
    .chain(({ action, unit, valor, alto, bajo }) => {
      const esPresupuesto = action === 'budget_increase' || action === 'budget_decrease';
      const techo = Math.max(alto, bajo);
      const piso = Math.min(alto, bajo);

      let actionValue: number | null = null;
      let actionUnit: 'percent' | 'fixed' | null = null;
      if (esPresupuesto) {
        actionUnit = unit;
        actionValue =
          unit === 'percent'
            ? // Dirección del factor (CHECK ad_rules_percent_direccion): subir
              // necesita factor > 100, bajar necesita factor < 100.
              action === 'budget_increase'
              ? 101 + (valor % 299)
              : 1 + (valor % 98)
            : valor;
      }
      const budgetMax = action === 'budget_increase' ? techo : null;
      const budgetMin = action === 'budget_decrease' ? piso : null;

      const nivel = esPresupuesto
        ? fc.constantFrom<Regla['level']>('campaign', 'adset')
        : fc.constantFrom<Regla['level']>('campaign', 'adset', 'ad');

      return fc
        .record({
          id: fc.integer({ min: 1, max: 2_000_000_000 }),
          name: genNombreRegla(),
          enabled: fc.boolean(),
          dryRun: fc.boolean(),
          accountId: idCuenta(),
          level: nivel,
          // El estado se elige SEGÚN la acción: pausar mirando sólo pausados
          // (y activar mirando sólo activos) es un no-op garantizado y el API
          // lo rechaza desde `motivoAlcanceInutil`. Es la misma clase de
          // acoplamiento que ya tienen los campos de presupuesto acá arriba.
          statusFilter:
            action === 'pause'
              ? fc.constantFrom<'active' | 'paused' | 'any'>('active', 'any')
              : action === 'activate'
                ? fc.constantFrom<'active' | 'paused' | 'any'>('paused', 'any')
                : fc.constantFrom<'active' | 'paused' | 'any'>('active', 'paused', 'any'),
          nameFilter: fc.option(fc.string({ minLength: 2, maxLength: 12 }), { nil: null }),
          nameFilterMode: fc.constantFrom<'contains' | 'not_contains'>('contains', 'not_contains'),
          period: fc.constantFrom<PeriodoAds>('today', 'yesterday', '7d', '7d_excl_today'),
          everyMinutes: fc.integer({ min: 1, max: 1440 }),
          // Las dos horas distintas: con inicio == fin la ventana dura un minuto
          // y el API la rechaza (`motivoVentanaInvalida`). Cruzar la medianoche
          // (inicio > fin) sí se genera: es válido y el evaluador lo soporta.
          ventana: fc.option(
            fc.tuple(horaMinuto(), horaMinuto()).filter(([a, b]) => a !== b),
            { nil: null },
          ),
          maxRunsPerDay: fc.option(fc.integer({ min: 1, max: 24 }), { nil: null }),
          cooldownMinutes: fc.integer({ min: 0, max: 240 }),
          maxActionsPerObjectPerDay: fc.integer({ min: 1, max: 25 }),
        })
        .map((b) => ({
          ...b,
          action,
          actionValue,
          actionUnit,
          budgetMax,
          budgetMin,
          metricsLevel: 'object' as const,
          windowStart: b.ventana?.[0] ?? null,
          windowEnd: b.ventana?.[1] ?? null,
        }));
    });
}

/** La forma que acepta el zod de `app/api/ads/reglas/route.ts` (sin `id`: es
 *  un payload de creación), con 0..10 condiciones y `enabled`/`dryRun` en
 *  cualquier valor. Sale de `genRegla()`, así que es coherente con los
 *  superRefine del zod. */
export type PayloadRegla = {
  name: string;
  accountId: string;
  level: NivelAds;
  statusFilter?: 'active' | 'paused' | 'any';
  nameFilter?: string | null;
  nameFilterMode?: 'contains' | 'not_contains';
  action: Regla['action'];
  actionValue?: number | null;
  actionUnit?: 'percent' | 'fixed' | null;
  budgetMax?: number | null;
  budgetMin?: number | null;
  period?: PeriodoAds;
  metricsLevel?: string;
  everyMinutes?: number;
  windowStart?: string | null;
  windowEnd?: string | null;
  maxRunsPerDay?: number | null;
  cooldownMinutes?: number;
  maxActionsPerObjectPerDay?: number;
  conditions: Condicion[];
  enabled?: boolean;
  dryRun?: boolean;
};

export function genReglaPayload(): fc.Arbitrary<PayloadRegla> {
  return genRegla().chain((r) => {
    // Umbrales realistas: importes en EUR, porcentajes y ratios entre -1000 y
    // 1000 con A LO SUMO 2 decimales. Se generan en céntimos y se dividen, por
    // dos motivos concretos:
    //   1. `fc.float` produce `-0`, que la ida y vuelta por el API devuelve como
    //      `+0` y `Object.is` (el comparador de `toBe`) distingue de `-0`.
    //   2. `fc.float` es de 32 bits y produce denormales como 1.4e-45, que
    //      `numeric(16,4)` redondea a 0.0000. Ninguno de los dos es un umbral
    //      que una persona escriba en el formulario.
    const condiciones = fc
      .array(
        fc
          .tuple(
            fc.constantFrom(...METRICAS_CONDICION),
            fc.constantFrom(...OPS_CONDICION),
            fc.integer({ min: -100_000, max: 100_000 }).map((centimos) => centimos / 100),
          )
          .map(([metric, op, value]) => ({ metric, op, value })),
        { minLength: 0, maxLength: 10 },
      )
      // Con hasta diez condiciones sobre trece métricas, dos sobre la misma
      // métrica que se contradicen («gasto > 10» y «gasto < 5») salen solas, y
      // el API las rechaza porque describen un conjunto vacío. Se filtra con LA
      // MISMA función que valida el API, así el generador no puede quedar
      // describiendo un contrato que ya no existe.
      .filter((cs) => motivoCondicionesImposibles(cs) === null);
    return fc
      .tuple(condiciones, fc.boolean(), fc.boolean())
      .map(([conditions, enabled, dryRun]) => ({
        name: r.name,
        accountId: r.accountId,
        level: r.level,
        statusFilter: r.statusFilter,
        nameFilter: r.nameFilter,
        nameFilterMode: r.nameFilterMode,
        action: r.action,
        actionValue: r.actionValue,
        actionUnit: r.actionUnit,
        budgetMax: r.budgetMax,
        budgetMin: r.budgetMin,
        period: r.period,
        metricsLevel: r.metricsLevel,
        everyMinutes: r.everyMinutes,
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        maxRunsPerDay: r.maxRunsPerDay,
        cooldownMinutes: r.cooldownMinutes,
        maxActionsPerObjectPerDay: r.maxActionsPerObjectPerDay,
        conditions,
        enabled,
        dryRun,
      }));
  });
}

// ─── genEventosSeleccion ─────────────────────────────────────────────────────

const POOL_IDS: Record<NivelAds, string[]> = {
  campaign: ['c1', 'c2', 'c3', 'c4'],
  adset: ['s1', 's2', 's3', 's4', 's5'],
  ad: ['a1', 'a2', 'a3', 'a4'],
};

const TODOS_IDS_DE_LA_CUENTA = new Set([...POOL_IDS.campaign, ...POOL_IDS.adset]);

/** Secuencia al azar de eventos de selección. Los eventos de tilde usan ids del
 *  nivel VIGENTE en ese punto de la secuencia (el generador sigue al estado),
 *  así la Property 8 puede verificar que ningún id cruza niveles. */
export function genEventosSeleccion(): fc.Arbitrary<EventoSeleccion[]> {
  const unEvento = (
    nivelActual: NivelAds,
  ): fc.Arbitrary<{ ev: EventoSeleccion; nivel: NivelAds }> =>
    fc.oneof(
      fc
        .constantFrom(...POOL_IDS[nivelActual])
        .map((id) => ({ ev: { tipo: 'tildar', id } as EventoSeleccion, nivel: nivelActual })),
      fc
        .constantFrom(...POOL_IDS[nivelActual])
        .map((id) => ({ ev: { tipo: 'destildar', id } as EventoSeleccion, nivel: nivelActual })),
      fc
        .array(fc.constantFrom(...POOL_IDS[nivelActual]), { minLength: 0, maxLength: 6 })
        .map(
          (idsPagina) =>
            ({ ev: { tipo: 'tildar_todas', idsPagina } as EventoSeleccion, nivel: nivelActual }),
        ),
      fc.constantFrom(...NIVELES_FC).map((nivel) => ({
        ev: {
          tipo: 'cambiar_nivel',
          nivel,
          idsDeLaCuenta: TODOS_IDS_DE_LA_CUENTA,
        } as EventoSeleccion,
        nivel,
      })),
      fc.constant({ ev: { tipo: 'cambiar_filtro' } as EventoSeleccion, nivel: nivelActual }),
      fc.constant({ ev: { tipo: 'limpiar_cascada' } as EventoSeleccion, nivel: nivelActual }),
    );

  const secuencia = (nivel: NivelAds, restantes: number): fc.Arbitrary<EventoSeleccion[]> => {
    if (restantes <= 0) return fc.constant([]);
    return unEvento(nivel).chain(({ ev, nivel: nuevo }) =>
      secuencia(nuevo, restantes - 1).map((resto) => [ev, ...resto]),
    );
  };

  return fc.integer({ min: 1, max: 40 }).chain((n) => secuencia('campaign', n));
}
