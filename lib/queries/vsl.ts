/**
 * vsl.ts — retención de un VSL, sin test A/B: ¿lo miran entero? ¿en qué
 * segundo se van? ¿cuántos llegan a la oferta?
 *
 * Lee los mismos eventos `vsl_*` que `pitch.ts` (contrato en
 * `lib/vsl-retention.ts` de cada funnel) pero para UNA página (`props.vsl_page`:
 * `plan`, `upsell-u1`…), sin brazos. Todo se mide con el sonido activado:
 *
 *  - `vsl_sound_on` → base: sesiones que activaron el sonido.
 *  - `vsl_audio`    → máximo `sec` por sesión = hasta dónde escuchó.
 *  - `vsl_pitch`    → llegó a la oferta (`at_sec` = segundo de la oferta).
 *  - `props.dur`    → duración del video (la manda el funnel desde 2026-10-27;
 *    sin ella no se puede decir quién lo terminó y la card lo avisa).
 */

import { q } from '@/lib/db';
import { grillaHitos } from '@/lib/queries/pitch';

export type VslFilters = {
  funnelId: number;
  /** 'YYYY-MM-DD' en la TZ del funnel. */
  from: string;
  to: string;
  /** `props.vsl_page`. Sin valor: la página con más sesiones con sonido. */
  page?: string | null;
};

export type VslPagina = { page: string; conSonido: number };

export type VslPunto = {
  segundo: number;
  /** Sesiones que escucharon al menos hasta este segundo. */
  sesiones: number;
  /** % sobre las que activaron el sonido, 0-100. */
  pct: number;
};

export type VslTramo = { desde: number; hasta: number; seFueron: number; pct: number };

export type VslData = {
  paginas: VslPagina[];
  page: string | null;
  conSonido: number;
  /** Segundos escuchados: mediana y promedio por sesión con sonido. */
  medianaSec: number | null;
  promedioSec: number | null;
  /** Duración del video (moda de `props.dur`); null si el funnel no la manda. */
  duracionSec: number | null;
  /** Sesiones que llegaron a menos de 10 s del final. null sin duración. */
  terminaron: number | null;
  /** Sesiones a las que se les reveló la oferta mientras escuchaban. */
  llegaronOferta: number;
  ofertaEnSec: number | null;
  curva: VslPunto[];
  /** Tramos de 30 s ordenados por cuánta gente se fue ahí (los peores primero). */
  peoresTramos: VslTramo[];
  generatedAt: string;
};

/** Margen para contar "lo terminó": el flush final rara vez cae en el último segundo exacto. */
export const MARGEN_FINAL_SEC = 10;
export const TRAMO_SEC = 30;

/** PURA: mediana de un histograma `{valor, n}`. */
export function medianaHistograma(h: { maxSec: number; sesiones: number }[]): number | null {
  const total = h.reduce((a, f) => a + f.sesiones, 0);
  if (total === 0) return null;
  const ord = [...h].sort((a, b) => a.maxSec - b.maxSec);
  let acc = 0;
  for (const f of ord) {
    acc += f.sesiones;
    if (acc * 2 >= total) return f.maxSec;
  }
  return ord[ord.length - 1]!.maxSec;
}

/**
 * PURA: curva de retención contra la base de los que activaron el sonido.
 * Cuenta SESIONES cuyo máximo llegó al hito (como `armarCurvaRetencion`), con
 * el punto 0 en 100 % y, si hay duración, un último punto en el final.
 */
export function curvaVsl(
  h: { maxSec: number; sesiones: number }[],
  base: number,
  duracion: number | null,
): VslPunto[] {
  if (base === 0) return [];
  const techo = Math.max(duracion ?? 0, ...h.map((f) => f.maxSec), 0);
  if (techo <= 0) return [];
  const grilla = [0, ...grillaHitos(techo).filter((s) => s < techo)];
  if (duracion) grilla.push(Math.max(0, duracion - MARGEN_FINAL_SEC));
  return grilla.map((segundo) => {
    const sesiones =
      segundo === 0 ? base : h.reduce((a, f) => (f.maxSec >= segundo ? a + f.sesiones : a), 0);
    return { segundo, sesiones, pct: Math.min(100, (sesiones / base) * 100) };
  });
}

/** PURA: en qué tramo de 30 s cortó cada sesión; los tramos con más salidas primero. */
export function peoresTramos(
  h: { maxSec: number; sesiones: number }[],
  base: number,
  duracion: number | null,
  top = 3,
): VslTramo[] {
  if (base === 0) return [];
  const porTramo = new Map<number, number>();
  for (const f of h) {
    // Quien lo terminó no "se fue" en ningún tramo.
    if (duracion && f.maxSec >= duracion - MARGEN_FINAL_SEC) continue;
    const desde = Math.floor(f.maxSec / TRAMO_SEC) * TRAMO_SEC;
    porTramo.set(desde, (porTramo.get(desde) ?? 0) + f.sesiones);
  }
  return [...porTramo.entries()]
    .map(([desde, seFueron]) => ({ desde, hasta: desde + TRAMO_SEC, seFueron, pct: (seFueron / base) * 100 }))
    .sort((a, b) => b.seFueron - a.seFueron || a.desde - b.desde)
    .slice(0, top);
}

// `CASE` con `jsonb_typeof`: un `->>'sec'::int` sobre un valor no numérico tira
// la query entera (ver el mismo guard en pitch.ts).
const NUM = (k: string) =>
  `CASE WHEN jsonb_typeof(e.props->'${k}') = 'number' THEN floor((e.props->>'${k}')::numeric)::int END`;

export async function getVslData(f: VslFilters): Promise<VslData> {
  const base = [f.funnelId, f.from, f.to];
  const paginas = await q<VslPagina>(
    `SELECT e.props->>'vsl_page' AS page, count(DISTINCT e.session_id)::int AS "conSonido"
       FROM events e
      WHERE e.funnel_id = $1 AND e.day BETWEEN $2::date AND $3::date
        AND e.name = 'vsl_sound_on' AND e.props->>'vsl_page' IS NOT NULL
      GROUP BY 1`,
    base,
  );
  paginas.sort((a, b) => b.conSonido - a.conSonido || a.page.localeCompare(b.page, 'es'));

  const page =
    f.page && paginas.some((p) => p.page === f.page)
      ? f.page
      : (paginas.find((p) => p.page === 'plan')?.page ?? paginas[0]?.page ?? null);

  const vacio: VslData = {
    paginas,
    page,
    conSonido: 0,
    medianaSec: null,
    promedioSec: null,
    duracionSec: null,
    terminaron: null,
    llegaronOferta: 0,
    ofertaEnSec: null,
    curva: [],
    peoresTramos: [],
    generatedAt: new Date().toISOString(),
  };
  if (!page) return vacio;

  const params = [...base, page];
  const W = `e.funnel_id = $1 AND e.day BETWEEN $2::date AND $3::date AND e.props->>'vsl_page' = $4`;

  const [histograma, extra] = await Promise.all([
    // Máximo segundo con sonido por sesión, solo de las que activaron el sonido.
    q<{ maxSec: number; sesiones: number }>(
      `SELECT "maxSec", count(*)::int AS sesiones FROM (
         SELECT e.session_id, max(${NUM('sec')}) AS "maxSec"
           FROM events e
          WHERE ${W} AND e.name = 'vsl_audio'
            AND e.session_id IN (SELECT session_id FROM events e WHERE ${W} AND e.name = 'vsl_sound_on')
          GROUP BY 1
       ) t WHERE "maxSec" IS NOT NULL GROUP BY 1`,
      params,
    ),
    q<{ conSonido: number; oferta: number; ofertaEnSec: number | null; dur: number | null }>(
      `SELECT
         (SELECT count(DISTINCT session_id) FROM events e WHERE ${W} AND e.name = 'vsl_sound_on')::int AS "conSonido",
         (SELECT count(DISTINCT session_id) FROM events e WHERE ${W} AND e.name = 'vsl_pitch')::int AS oferta,
         (SELECT mode() WITHIN GROUP (ORDER BY ${NUM('at_sec')}) FROM events e WHERE ${W} AND e.name = 'vsl_pitch') AS "ofertaEnSec",
         (SELECT mode() WITHIN GROUP (ORDER BY ${NUM('dur')}) FROM events e
           WHERE ${W} AND e.name LIKE 'vsl%' AND jsonb_typeof(e.props->'dur') = 'number') AS dur`,
      params,
    ),
  ]);

  const x = extra[0]!;
  const conSonido = x.conSonido;
  const duracion = x.dur && x.dur > 0 ? x.dur : null;
  const totalH = histograma.reduce((a, h) => a + h.sesiones, 0);
  const suma = histograma.reduce((a, h) => a + h.maxSec * h.sesiones, 0);

  return {
    ...vacio,
    conSonido,
    medianaSec: medianaHistograma(histograma),
    promedioSec: totalH > 0 ? suma / totalH : null,
    duracionSec: duracion,
    terminaron: duracion
      ? histograma.reduce((a, h) => (h.maxSec >= duracion - MARGEN_FINAL_SEC ? a + h.sesiones : a), 0)
      : null,
    llegaronOferta: x.oferta,
    ofertaEnSec: x.ofertaEnSec,
    curva: curvaVsl(histograma, conSonido, duracion),
    peoresTramos: peoresTramos(histograma, conSonido, duracion),
  };
}
