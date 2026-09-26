'use client';

/**
 * CardTestEstetica — el A/B de estética del quiz de almagemela, en /embudo.
 *
 * El funnel reparte 50/50 a quienes ven el quiz real en los dominios del test:
 * la mitad ve el quiz original y la otra mitad el mismo quiz (mismas preguntas,
 * mismo chat, mismo checkout) con otra estética. Cada visitante ve siempre la
 * misma. El brazo viaja como `sessions.experiment` = `estetica_original` |
 * `estetica_tarot` (ver `nuevo-quiz-funnel/lib/variante.ts`).
 *
 * Una tercera fila, `estetica_original_hilvanapp`, es el tráfico de los
 * anuncios de almagemela.hilvanapp.online, que ve siempre el quiz original
 * (pedido del operador 2026-09-26: verlo al lado). Es REFERENCIA: no entra en
 * el ganador ni en el aviso de muestra, porque es otra campaña y otra gente, y
 * compararla contra el tarot mediría los anuncios y no la estética.
 *
 * Contesta UNA pregunta: qué estética deja más plata por sesión.
 *
 * A diferencia de CardPitch, NO trae sus datos por su cuenta: lee
 * `FunnelData.experiments`, el desglose por experimento que `getFunnelData` ya
 * calculaba y ninguna vista leía desde que se cerró el test de portada. Es
 * exactamente la pregunta de un test de entrada (sesiones → compras → plata,
 * atribuida por cohorte de sesión), así que armar otra query sería duplicarla.
 *
 * Lo que NO hace, a propósito (ver `gates.test.ts`, por qué se sacó la
 * superficie de la portada): no recorta el embudo. No hay `?exp=` ni toggle; la
 * card muestra los dos brazos lado a lado y el resto de la pantalla sigue
 * siendo del funnel completo. Sí respeta los filtros de arriba (rango, campaña,
 * país), porque sale del mismo WHERE que el resto de la pantalla.
 *
 * SIN TEST DE SIGNIFICANCIA, mismo criterio que CardPitch: conteos absolutos al
 * lado de cada tasa y un aviso mientras la muestra no alcance.
 */

import type { Funnel } from '@/lib/funnels';
import type { ExperimentoRow } from '@/lib/queries/funnel';
import { SIN_EXPERIMENTO } from '@/lib/experimento';
import { panelColors } from '@/tailwind.config';
import { Banner, Card, EmptyState, Table, fmtInt, fmtMoney, fmtPct } from '@/components/ui';

/** Prefijo de los brazos de este test en `sessions.experiment`. */
export const PREFIJO_ESTETICA = 'estetica_';

/** Compras por brazo por debajo de las cuales la diferencia todavía es ruido. */
export const MIN_COMPRAS_POR_BRAZO = 100;

/** Los dos brazos que compiten. Todo otro `estetica_*` es referencia. */
export const BRAZOS_DEL_TEST = ['estetica_original', 'estetica_tarot'];

/** Qué es cada fila, dicho para quien mira el panel y no el código. */
const ETIQUETA_BRAZO: Record<string, { nombre: string; detalle: string }> = {
  estetica_original: { nombre: 'Original', detalle: 'el quiz de siempre · dominios .online' },
  estetica_tarot: { nombre: 'Tarot', detalle: 'el quiz nuevo, mismas preguntas · dominios .online' },
  estetica_original_hilvanapp: {
    nombre: 'Original · anuncios',
    detalle: 'almagemela.hilvanapp.online · referencia, fuera del test',
  },
};

/** `original` es el control, en neutro; `tarot` en el dorado de su estética. */
const COLOR_BRAZO: Record<string, string> = {
  estetica_original: panelColors.info,
  estetica_tarot: panelColors.warn,
};

export function esBrazoDelTest(experiment: string): boolean {
  return BRAZOS_DEL_TEST.includes(experiment);
}

/**
 * ¿Se muestra la card? Predicado PURO. Mira los brazos DECLARADOS
 * (`funnels.experiments`), igual que CardPitch: un funnel que declaró el test
 * y todavía no juntó datos ve la card con su estado vacío.
 */
export function debeMostrarCardEstetica(experimentsDeclarados: string[]): boolean {
  return experimentsDeclarados.some((e) => e.startsWith(PREFIJO_ESTETICA));
}

/**
 * Las filas de este test, en orden: los dos brazos que compiten y después las
 * de referencia. Fuera `(sin asignar)` y los brazos de otros tests.
 */
export function brazosEstetica(filas: ExperimentoRow[]): ExperimentoRow[] {
  const propias = filas.filter((f) => f.experiment.startsWith(PREFIJO_ESTETICA));
  const orden = (e: string) => {
    const i = BRAZOS_DEL_TEST.indexOf(e);
    return i === -1 ? BRAZOS_DEL_TEST.length : i;
  };
  return [...propias].sort((a, b) => orden(a.experiment) - orden(b.experiment));
}

/** `estetica_tarot` → `Tarot`. El prefijo es para la base, no para la pantalla. */
export function nombreBrazoEstetica(experiment: string): string {
  const conocido = ETIQUETA_BRAZO[experiment];
  if (conocido) return conocido.nombre;
  const corto = experiment.startsWith(PREFIJO_ESTETICA)
    ? experiment.slice(PREFIJO_ESTETICA.length)
    : experiment;
  if (corto === '') return experiment;
  return corto.charAt(0).toUpperCase() + corto.slice(1);
}

/**
 * El brazo que va ganando por plata por sesión, la métrica que decide. Solo
 * entre los brazos del test (la fila de referencia nunca gana). null con menos
 * de dos brazos con sesiones, o con empate: no hay a quién marcar.
 */
export function liderEstetica(brazos: ExperimentoRow[]): ExperimentoRow | null {
  const conSesiones = brazos.filter((b) => esBrazoDelTest(b.experiment) && b.sessions > 0);
  if (conSesiones.length < 2) return null;
  const ordenados = [...conSesiones].sort((a, b) => b.revenuePerSession - a.revenuePerSession);
  if (ordenados[0]!.revenuePerSession === ordenados[1]!.revenuePerSession) return null;
  return ordenados[0]!;
}

/**
 * true mientras falte un brazo del test o el más chico no llegue a
 * MIN_COMPRAS_POR_BRAZO. La fila de referencia no cuenta.
 */
export function muestraChicaEstetica(brazos: ExperimentoRow[]): boolean {
  const delTest = brazos.filter((b) => esBrazoDelTest(b.experiment));
  if (delTest.length < 2) return true;
  return Math.min(...delTest.map((b) => b.purchases)) < MIN_COMPRAS_POR_BRAZO;
}

export function CardTestEstetica({ funnel, filas }: { funnel: Funnel; filas: ExperimentoRow[] }) {
  const brazos = brazosEstetica(filas);
  const delTest = brazos.filter((b) => esBrazoDelTest(b.experiment));
  const hayReferencia = brazos.some((b) => !esBrazoDelTest(b.experiment));
  const fueraDelTest = filas.find((f) => f.experiment === SIN_EXPERIMENTO)?.sessions ?? 0;
  const lider = liderEstetica(brazos);
  const moneda = funnel.sellCurrency;

  return (
    <Card
      title="Test A/B de estética del quiz"
      hint="La mitad de las visitas del test ve el quiz original y la otra mitad el mismo quiz con la estética tarot: mismas preguntas, mismo chat, mismo checkout. Cada persona ve siempre la misma. La columna que decide es la plata por sesión: normaliza por tráfico (el reparto nunca queda exacto) y ya cuenta upsells y reembolsos. Las compras cuentan en el día en que empezó la sesión. Respeta los filtros de arriba."
    >
      {brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones del test en este rango"
          hint="El test corre solo en los dominios donde está prendido. Si el rango es anterior a que arrancara, o esos dominios todavía no recibieron tráfico, no hay nada que comparar."
        />
      ) : (
        <div className="space-y-5">
          {muestraChicaEstetica(brazos) && (
            <Banner tone="warn" title="Muestra chica: todavía no alcanza para decidir">
              Hacen falta al menos{' '}
              <span className="font-semibold tabular-nums">{MIN_COMPRAS_POR_BRAZO}</span> compras por
              brazo, y{' '}
              {delTest.length < 2
                ? 'por ahora llegó uno solo.'
                : `el más chico tiene ${fmtInt(Math.min(...delTest.map((b) => b.purchases)))}.`}{' '}
              Los números son reales, pero la diferencia todavía puede darse vuelta sola.
            </Banner>
          )}

          <Table
            rows={brazos}
            empty="Sin datos"
            columns={[
              {
                key: 'experiment',
                header: 'Estética',
                render: (r) => (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: COLOR_BRAZO[r.experiment] ?? panelColors.muted }}
                    />
                    <span className="flex flex-col leading-tight">
                      <span
                        className={`font-medium ${
                          esBrazoDelTest(r.experiment) ? 'text-neutral-100' : 'text-neutral-400'
                        }`}
                      >
                        {nombreBrazoEstetica(r.experiment)}
                      </span>
                      {ETIQUETA_BRAZO[r.experiment] && (
                        <span className="text-[11px] max-panel:text-xs text-neutral-500">
                          {ETIQUETA_BRAZO[r.experiment]!.detalle}
                        </span>
                      )}
                    </span>
                  </span>
                ),
              },
              {
                key: 'sessions',
                header: 'Sesiones',
                align: 'right',
                render: (r) => fmtInt(r.sessions),
              },
              {
                key: 'salesViews',
                header: 'Llegó a la oferta',
                align: 'right',
                render: (r) => (
                  <span className="tabular-nums">
                    {fmtInt(r.salesViews)}{' '}
                    <span className="text-xs text-neutral-500">({fmtPct(r.pctSalesView, 0)})</span>
                  </span>
                ),
              },
              {
                key: 'purchases',
                header: 'Compras',
                align: 'right',
                render: (r) => fmtInt(r.purchases),
              },
              {
                key: 'pctSessionToPurchase',
                header: 'Conversión',
                align: 'right',
                render: (r) => (
                  <span className="flex flex-col items-end leading-tight">
                    <span className="tabular-nums text-neutral-100">
                      {r.sessions > 0 ? fmtPct(r.pctSessionToPurchase, 2) : '—'}
                    </span>
                    <span className="text-[11px] max-panel:text-xs tabular-nums text-neutral-500">
                      {fmtInt(r.purchases)}/{fmtInt(r.sessions)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'revenue',
                header: 'Facturación',
                align: 'right',
                render: (r) => <span className="tabular-nums">{fmtMoney(r.revenue, moneda)}</span>,
              },
              {
                // La columna que decide, resaltada en el brazo que va ganando.
                key: 'revenuePerSession',
                header: `${moneda}/sesión`,
                align: 'right',
                render: (r) => (
                  <span
                    className={`font-semibold tabular-nums ${
                      lider?.experiment === r.experiment
                        ? 'text-good-300'
                        : esBrazoDelTest(r.experiment)
                          ? 'text-neutral-50'
                          : 'text-neutral-400'
                    }`}
                  >
                    {r.sessions > 0 ? fmtMoney(r.revenuePerSession, moneda) : '—'}
                  </span>
                ),
              },
            ]}
          />

          {hayReferencia && (
            <p className="max-w-[70ch] text-pretty text-xs leading-relaxed text-neutral-500">
              La fila «Original · anuncios» es el tráfico de tus anuncios en
              almagemela.hilvanapp.online, que ve siempre el quiz original. Está como referencia y no
              compite: es otra campaña y otra gente, así que compararla con el tarot mediría los
              anuncios y no la estética. El ganador sale solo de Original contra Tarot.
            </p>
          )}

          {fueraDelTest > 0 && (
            <p className="max-w-[70ch] text-pretty text-xs leading-relaxed text-neutral-500">
              Además hubo <span className="tabular-nums">{fmtInt(fueraDelTest)}</span> sesiones fuera
              del test (sin etiqueta: visitas de antes de que arrancara, u otros dominios): no entran
              en esta tabla.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
