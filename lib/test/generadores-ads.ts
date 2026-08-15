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
import type { ClaveOrden, MetricasObjeto, NivelAds } from '../ads/tipos';
import { CATALOGO_METRICAS, type ColumnaVisible } from '../ads/catalogo';
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
