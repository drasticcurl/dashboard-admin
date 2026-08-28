/**
 * pitch.ts — lectura del A/B del pitch del upsell.
 *
 * Responde DOS preguntas y nada más:
 *   1. ¿Qué brazo vende más upsells?
 *   2. ¿En qué segundo del VSL se va la gente, y cómo cambia eso entre brazos?
 *
 * El experimento mide en qué segundo del VSL de `/upsell` aparece el bloque de
 * oferta: brazo A a los 265 s, brazo B a los 300 s, mismo MP4 y mismo precio. Lo
 * define `testfunnel/lib/quiz-v2/pitchVariant.ts` y llega al panel como
 * `sessions.experiment` con los valores `pitch_A` / `pitch_B`.
 *
 * POR QUÉ ESTE MÓDULO EXISTE APARTE DE `funnel.ts`, que ya tiene un desglose por
 * `experiment`: ese desglose se diseñó para un test de PORTADA, donde el brazo se
 * asigna en la landing y el embudo entero queda aguas abajo. Este test asigna el
 * brazo DENTRO de `/upsell`, y para llegar ahí la sesión ya compró el front.
 * Consecuencia medida: `pctSalesView`, `pctCheckoutClick`, `pctPurchase` y
 * `pctSessionToPurchase` dan 100,0 fijo en los dos brazos, y la única columna que
 * se mueve es `pctUpsellTake`, que mide CLICKS sobre compras del front. Con un
 * escenario donde A vende 12 upsells y B vende 8:
 *
 *     brazo   | desglose de funnel.ts | correcto (ventas/vistas upsell)
 *    ---------+-----------------------+---------------------------------
 *     pitch_A |                  50,0 |                            30,0
 *     pitch_B |                  60,0 |                            20,0
 *
 * El desglose viejo dice que gana B. Gana A. De ahí que este módulo escriba su
 * propia query en vez de reenchufar la que había. Y como vive aparte, el día que
 * el test cierre se borra un archivo y una card, no se desarma el embudo.
 */

import { q } from '@/lib/db';

/**
 * Prefijo de la dimensión de este experimento.
 *
 * EL FILTRO POR PREFIJO NO ES OPCIONAL. `sessions.experiment` es un slot único
 * que cada test que corre reusa, y hoy tiene cuatro valores de dos experimentos
 * distintos. Medido en producción el 2026-08-21, últimos 14 días de
 * `chauhinchazon`: 4107 sesiones en `A` y 4114 en `B` (test de portada, cerrado)
 * contra 38 en `pitch_A` y 29 en `pitch_B` (este test). Sin el filtro, la card
 * muestra cuatro filas donde dos tienen cien veces más volumen y pertenecen a
 * otra pregunta.
 */
export const PITCH_PREFIX = 'pitch_';

/**
 * Vistas de `/upsell` que tiene que tener CADA brazo para que la comparación se
 * lea como una comparación y no como ruido.
 *
 * Es un PISO PARA MIRAR, no una regla de parada: con menos que esto la card no
 * dice "empate", dice "todavía no hay con qué". La diferencia importa porque
 * "empate" invita a cerrar el test y "junten más datos" no.
 *
 * No hay test de significancia y es deliberado: lo que se muestra son los números
 * absolutos al lado del porcentaje, más este aviso. Un p-valor sobre 37 vistas es
 * ruido con formato de número, y presentarlo invita a decidir con él.
 */
export const MIN_VISTAS_POR_BRAZO = 100;

export type PitchFilters = {
  funnelId: number;
  /** 'YYYY-MM-DD' en la TZ del funnel, igual que FunnelFilters. */
  from: string;
  to: string;
};

/** Contadores crudos de un brazo, tal como salen de SQL. */
export type PitchContadores = {
  /** El valor de `sessions.experiment` tal cual: 'pitch_A'. */
  brazo: string;
  /** Sesiones con `upsell_view_at`: el denominador de todo este módulo. */
  vistasUpsell: number;
  /** Sesiones con `upsell_click_at`. */
  clicks: number;
  /** Sesiones con al menos una orden aprobada de tier `upsell` o `upsell2`. */
  ventas: number;
  /** De esas, las que además compraron `upsell2` (el VIP). */
  ventasVip: number;
  /** Plata aprobada de tier upsell/upsell2, en la moneda de venta del funnel. */
  revenue: number;
  /** Sesiones que activaron el sonido del VSL (emitieron `vsl_sound_on`). */
  conSonido: number;
  /**
   * Segundo en el que este brazo reveló el precio, MEDIDO (no configurado).
   *
   * Sale de `props.at_sec` del evento `vsl_pitch`, así que es el segundo que el
   * reproductor usó de verdad. `null` si ningún evento lo trajo en el rango.
   *
   * Se mide en lugar de hardcodearse porque los segundos viven en
   * `NEXT_PUBLIC_UPSELL_OFFER_AT_SEC` y `NEXT_PUBLIC_AB_PITCH_B_SEC` del funnel,
   * que son `NEXT_PUBLIC_*` inlineadas en build: el panel no puede leerlas ni
   * verificarlas. Una constante acá sería inventar una fuente de verdad que no lo
   * es, y quedaría mintiendo en silencio el día que alguien mueva el brazo B.
   */
  reveladoEnSec: number | null;
};

/** Un brazo con sus tasas derivadas. Los % van 0-100. */
export type PitchBrazoRow = PitchContadores & {
  /** LA métrica que decide: ventas / vistasUpsell. */
  pctVentas: number;
  /** clicks / vistasUpsell. */
  pctClicks: number;
  /** ventas / clicks — cuánto cierra el checkout de los que apretaron. */
  pctCierre: number;
  /** conSonido / vistasUpsell — cuántos escucharon el pitch. */
  pctConSonido: number;
  /** Plata por vista de upsell. NO es un porcentaje. */
  revenuePorVista: number;
};

/** Un hito de la grilla de retención, con un valor por brazo. */
export type PitchRetencionPunto = {
  /** El segundo del hito: 5, 15, 30, 60, 120, … */
  segundo: number;
  /** Sesiones que llegaron a este hito o más allá, por brazo. */
  sesiones: Record<string, number>;
  /** % sobre la base del propio brazo, 0-100. */
  pct: Record<string, number>;
};

export type PitchData = {
  brazos: PitchBrazoRow[];
  retencion: PitchRetencionPunto[];
  /**
   * `true` si algún brazo no llega a `MIN_VISTAS_POR_BRAZO`. La card lo usa para
   * avisar en lugar de dejar comparar dos porcentajes sobre nada.
   */
  muestraChica: boolean;
  generatedAt: string;
};

// ─── Funciones puras ────────────────────────────────────────────────────────

/**
 * PURA: contadores → tasas, ordenadas por brazo alfabético.
 *
 * Denominador 0 ⇒ 0 con chequeo explícito. Nunca `|| 1`, nunca NaN, nunca
 * Infinity: acá el 0 tiene que ser visible en la card y no un 0 % derivado de una
 * división por 1.
 *
 * El orden se decide en TypeScript y no con un `ORDER BY` porque la collation de
 * la base cambia el resultado entre servidores. Mismo criterio que
 * `calcularTasasExperimento`.
 */
export function calcularTasasPitch(filas: PitchContadores[]): PitchBrazoRow[] {
  const pct = (numerador: number, denominador: number): number =>
    denominador === 0 ? 0 : (numerador / denominador) * 100;

  return [...filas]
    .sort((a, b) => a.brazo.localeCompare(b.brazo, 'es'))
    .map((f) => ({
      ...f,
      pctVentas: pct(f.ventas, f.vistasUpsell),
      pctClicks: pct(f.clicks, f.vistasUpsell),
      pctCierre: pct(f.ventas, f.clicks),
      pctConSonido: pct(f.conSonido, f.vistasUpsell),
      revenuePorVista: f.vistasUpsell === 0 ? 0 : f.revenue / f.vistasUpsell,
    }));
}

/**
 * Grilla de hitos de la retención, tal como la emite el funnel: 5, 15, 30 y de
 * ahí cada 60 s hasta `hasta`.
 *
 * Es DELIBERADAMENTE despareja y espeja `nextMilestone` de
 * `testfunnel/lib/vsl-retention.ts`: el acantilado de una VSL está en el primer
 * minuto, así que ahí hace falta resolución, pero cada hito es un POST y una
 * grilla uniforme de 5 s sobre un video de 441 s serían ~88 requests por sesión.
 */
export function grillaHitos(hasta: number): number[] {
  const grilla = [5, 15, 30];
  for (let s = 60; s <= hasta; s += 60) grilla.push(s);
  return grilla;
}

/**
 * PURA: histograma de "último segundo alcanzado por sesión" → curva de retención.
 *
 * CÓMO SE CUENTA, que es la parte que se puede hacer mal sin que se note: la
 * curva NO cuenta eventos por hito, cuenta SESIONES CUYO MÁXIMO LLEGÓ AL HITO.
 * Se hace con una suma acumulada inversa sobre el histograma, la misma técnica
 * que el embudo usa para `max_step_index`.
 *
 * Contar eventos por hito daría casi lo mismo y estaría mal por dos motivos: el
 * flush final emite un segundo EXACTO fuera de la grilla (47, 83…), que crearía
 * buckets espurios; y el ingest no deduplica eventos, así que un lote reenviado
 * infla el hito. Tomando el máximo por sesión los dos problemas desaparecen.
 *
 * `brazos` llega aparte y no se deduce de `filas` a propósito: un brazo puede no
 * tener ningún `vsl_audio` en el rango (nadie prendió el sonido) y aun así tener
 * que aparecer en las claves con 0. Deducirlo de las filas lo dejaría afuera y el
 * gráfico dibujaría una serie menos sin avisar.
 *
 * El % se normaliza contra el PRIMER hito del propio brazo, así los dos arrancan
 * en 100 % y lo que se compara es la FORMA de la caída. En conteos absolutos el
 * brazo con más tráfico parece retener mejor.
 */
export function armarCurvaRetencion(
  filas: { brazo: string; maxSec: number; sesiones: number }[],
  brazos: string[],
): PitchRetencionPunto[] {
  if (brazos.length === 0) return [];

  // Techo de la grilla: el máximo segundo observado. Sin datos no hay curva.
  const techo = filas.reduce((max, f) => Math.max(max, f.maxSec), 0);
  if (techo <= 0) return [];

  const grilla = grillaHitos(techo);

  // Sesiones que alcanzaron AL MENOS cada hito, por brazo (acumulada inversa).
  const alcanzaron = new Map<string, number[]>();
  for (const brazo of brazos) {
    const porHito = grilla.map((hito) =>
      filas.reduce((acc, f) => (f.brazo === brazo && f.maxSec >= hito ? acc + f.sesiones : acc), 0),
    );
    alcanzaron.set(brazo, porHito);
  }

  // La base de cada brazo es su PRIMER hito. Si un brazo no tiene a nadie en el
  // primer hito, su curva entera es 0: no se inventa una base más chica, porque
  // normalizar contra el segundo hito haría arrancar la curva en 100 % igual y
  // taparía que el brazo no tiene datos.
  const base = new Map<string, number>();
  for (const brazo of brazos) base.set(brazo, alcanzaron.get(brazo)![0] ?? 0);

  return grilla
    .map((segundo, i) => {
      const sesiones: Record<string, number> = {};
      const pct: Record<string, number> = {};
      for (const brazo of brazos) {
        const n = alcanzaron.get(brazo)![i] ?? 0;
        const b = base.get(brazo) ?? 0;
        sesiones[brazo] = n;
        pct[brazo] = b === 0 ? 0 : (n / b) * 100;
      }
      return { segundo, sesiones, pct };
    })
    // Solo hitos donde algún brazo tiene al menos una sesión: la cola de ceros
    // detrás del último espectador no dice nada y estira el gráfico.
    .filter((p) => brazos.some((b) => (p.sesiones[b] ?? 0) > 0));
}

// ─── La query ───────────────────────────────────────────────────────────────

/**
 * `WHERE` compartido por las dos consultas de sesiones.
 *
 * `starts_with(experiment, $4)` y NO `LIKE 'pitch_%'`: en `LIKE` el `_` es un
 * comodín de un carácter, así que `'pitch_%'` matchearía también un hipotético
 * `pitchXA`. La forma correcta sería escapar (`'pitch\_%'`), pero esta SQL vive
 * en un template literal de TypeScript y JavaScript se come la barra invertida
 * antes de que la SQL la vea: habría que escribir `'pitch\\_%'`, que funciona y es
 * exactamente el detalle que alguien "limpia" en seis meses y rompe en silencio.
 * `starts_with` no tiene comodines, así que no hay nada que escapar.
 *
 * Además implica `experiment IS NOT NULL`, así que el índice parcial
 * `sessions_funnel_day_experiment_idx` (migración 023) cubre exactamente este
 * acceso.
 */
const WHERE_PITCH = `
  funnel_id = $1
  AND day BETWEEN $2::date AND $3::date
  AND starts_with(experiment, $4)`;

export async function getPitchData(f: PitchFilters): Promise<PitchData> {
  const params = [f.funnelId, f.from, f.to, PITCH_PREFIX];

  const [contadores, sonido, revelado, histograma] = await Promise.all([
    // ── Brazos: denominador, clicks, ventas y plata ────────────────────────
    //
    // Las decisiones que no son obvias:
    //
    //  - `upsell_view_at` y NO `count(*)` como denominador: hay sesiones con
    //    dimensión que nunca vieron el upsell, porque `UpsellPageTracker` también
    //    corre en `/downsell` y usa `getPitchVariant()`, que ASIGNA en vez de
    //    leer. Medido en producción el 2026-08-21: 37 sesiones con
    //    `upsell_view_at` contra 40 con dimensión. Usar `count(*)` subestimaría
    //    los dos brazos con un sesgo que no es igual en ambos.
    //  - `EXISTS` y no un `count` de órdenes: `ventas` cuenta SESIONES que
    //    compraron. Una sesión con upsell + VIP tiene dos órdenes y contaría dos
    //    veces, dando una conversión mayor a 100 % contra un denominador que son
    //    sesiones.
    //  - `tier IN ('upsell','upsell2')` INCLUYE el downsell, y no es un olvido.
    //    El downsell es el MISMO producto de Shopify más barato, así que
    //    `product_map` lo clasifica como `tier='upsell'` (verificado: 14 órdenes
    //    de `tier='upsell'` con `amount = 14790`, el precio del downsell).
    //    Separarlo exigiría discriminar por monto, y los montos se movieron ocho
    //    veces en tres semanas: una regla por monto queda vieja al siguiente test
    //    de precio y falla en silencio. Y el downsell cuenta como venta igual: si
    //    el revelado corre gente del upsell al downsell, esa plata la trajo el
    //    brazo. `ventasVip` va aparte para que el VIP, que se vende en otra
    //    página, no se lea como si lo hubiera vendido el pitch.
    //  - `status = 'approved'`: la plata reembolsada no es una venta. Mismo
    //    criterio que el bruto de Ventas.
    //  - Subconsulta correlacionada y NO un `JOIN orders`: un join plano duplica
    //    la sesión con dos órdenes y arruina TODOS los `count(*)`, no solo el de
    //    plata. El `sum` va por dentro para que la sesión sin órdenes aporte 0 y
    //    siga contando en el denominador.
    //  - Sin `o.funnel_id` en la subconsulta: es atribución denormalizada y puede
    //    ser NULL, así que sumarlo descartaría en silencio ventas que no se
    //    pudieron atribuir pero sí tienen sesión. El funnel ya lo acota el WHERE.
    q<{
      brazo: string;
      vistasUpsell: number;
      clicks: number;
      ventas: number;
      ventasVip: number;
      revenue: number;
    }>(
      `SELECT experiment                                                    AS brazo,
              count(*) FILTER (WHERE upsell_view_at  IS NOT NULL)::int       AS "vistasUpsell",
              count(*) FILTER (WHERE upsell_click_at IS NOT NULL)::int       AS clicks,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o
                WHERE o.session_id = sessions.id
                  AND o.status = 'approved'
                  AND o.tier IN ('upsell', 'upsell2')
              ))::int                                                       AS ventas,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o
                WHERE o.session_id = sessions.id
                  AND o.status = 'approved'
                  AND o.tier = 'upsell2'
              ))::int                                                       AS "ventasVip",
              COALESCE(sum((
                SELECT COALESCE(sum(o.amount), 0) FROM orders o
                WHERE o.session_id = sessions.id
                  AND o.status = 'approved'
                  AND o.tier IN ('upsell', 'upsell2')
              )), 0)::float8                                                AS revenue
       FROM sessions
       WHERE ${WHERE_PITCH}
       GROUP BY 1`,
      params,
    ),

    // ── Sesiones que activaron el sonido, por brazo ────────────────────────
    // Es el denominador de "cuántos escucharon el pitch" y el contexto que le da
    // sentido a la curva: la retención se mide SOLO con sonido activado, porque
    // mirar el VSL muteado no es escuchar el pitch.
    q<{ brazo: string; conSonido: number }>(
      `SELECT s.experiment AS brazo, count(DISTINCT e.session_id)::int AS "conSonido"
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.funnel_id = $1
         AND e.day BETWEEN $2::date AND $3::date
         AND e.name = 'vsl_sound_on'
         AND starts_with(s.experiment, $4)
       GROUP BY 1`,
      params,
    ),

    // ── Segundo en el que cada brazo reveló el precio, medido ──────────────
    // `mode()` y no `max()`: si alguien movió la env var a mitad del rango, el
    // valor típico describe mejor al brazo que el extremo. El `CASE` con
    // `jsonb_typeof` es el mismo guard que abajo.
    q<{ brazo: string; atSec: number | null }>(
      `SELECT s.experiment AS brazo,
              mode() WITHIN GROUP (ORDER BY
                CASE WHEN jsonb_typeof(e.props->'at_sec') = 'number'
                     THEN floor((e.props->>'at_sec')::numeric)::int END
              ) AS "atSec"
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.funnel_id = $1
         AND e.day BETWEEN $2::date AND $3::date
         AND e.name = 'vsl_pitch'
         AND starts_with(s.experiment, $4)
       GROUP BY 1`,
      params,
    ),

    // ── Histograma del último segundo de audio por sesión ──────────────────
    //
    //  - `max(sec)` POR SESIÓN y después histograma: es lo que
    //    `vsl-retention.ts` documenta como la forma de leer estos eventos. Los
    //    hitos y el flush final usan el MISMO nombre de evento a propósito, así
    //    que el panel toma el máximo y no necesita saber cuál llegó; el flush no
    //    corrige al hito, lo supera.
    //  - El `CASE` con `jsonb_typeof` no es paranoia decorativa: `props` es jsonb
    //    que llegó de afuera y un `(props->>'sec')::int` sobre un valor no
    //    numérico TIRA EXCEPCIÓN y voltea la query entera, no esa fila. Y no
    //    alcanza con el guard en el `WHERE`: Postgres no garantiza que el `WHERE`
    //    se evalúe antes de la lista de selección. El `CASE` sí corta.
    //    `floor(...::numeric)` en vez de `::int` cubre que algún día llegue 42.5.
    //  - `props->>'vsl_page' = 'upsell'` excluye a LATAM, que emite los mismos
    //    `vsl_*` con `vsl_page = 'upsell-latam'` y no participa del test. Hoy es
    //    redundante (sus sesiones no tienen dimensión); se pone igual porque el
    //    día que LATAM entre, la curva tiene que seguir midiendo una sola página.
    q<{ brazo: string; maxSec: number; sesiones: number }>(
      `SELECT brazo, "maxSec", count(*)::int AS sesiones
       FROM (
         SELECT s.experiment AS brazo,
                e.session_id,
                max(CASE WHEN jsonb_typeof(e.props->'sec') = 'number'
                         THEN floor((e.props->>'sec')::numeric)::int END) AS "maxSec"
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.funnel_id = $1
           AND e.day BETWEEN $2::date AND $3::date
           AND e.name = 'vsl_audio'
           AND e.props->>'vsl_page' = 'upsell'
           AND starts_with(s.experiment, $4)
         GROUP BY 1, 2
       ) t
       WHERE "maxSec" IS NOT NULL
       GROUP BY 1, 2`,
      params,
    ),
  ]);

  const sonidoPorBrazo = new Map(sonido.map((r) => [r.brazo, r.conSonido]));
  const reveladoPorBrazo = new Map(revelado.map((r) => [r.brazo, r.atSec]));

  const brazos = calcularTasasPitch(
    contadores.map((c) => ({
      ...c,
      conSonido: sonidoPorBrazo.get(c.brazo) ?? 0,
      reveladoEnSec: reveladoPorBrazo.get(c.brazo) ?? null,
    })),
  );

  // Los brazos de la curva salen de los contadores y no del histograma: un brazo
  // sin un solo `vsl_audio` tiene que aparecer en el gráfico con su serie en 0,
  // no desaparecer.
  const retencion = armarCurvaRetencion(
    histograma,
    brazos.map((b) => b.brazo),
  );

  return {
    brazos,
    retencion,
    // Con un solo brazo también es muestra chica: no hay comparación posible.
    muestraChica:
      brazos.length < 2 || brazos.some((b) => b.vistasUpsell < MIN_VISTAS_POR_BRAZO),
    generatedAt: new Date().toISOString(),
  };
}
