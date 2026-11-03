"use client";

/**
 * CardTestPortada — el A/B/C/D de titulares de la portada del quiz de
 * calistenia-rusa-28, en /embudo.
 *
 * Cada sesión que entra al quiz real ve uno de cuatro titulares (25 % cada
 * uno, cookie `cr28_portada` en el funnel). El brazo viaja como
 * `sessions.experiment` = `portada_a` … `portada_d` desde el PRIMER evento,
 * así que acá cuentan también las sesiones que se fueron sin tocar nada.
 *
 * Lo que se lee primero es "pasaron la portada" (tocaron una opción): es la
 * métrica que el test quiere mover y la que junta muestra rápido. La plata por
 * sesión es la que decide al final, pero con pocas compras por brazo tarda
 * semanas en separarse.
 *
 * Mismo contrato que CardTestVsl: lee `FunnelData.experiments`, no recorta el
 * resto de la pantalla, aparece si llegan filas con los brazos aunque el
 * funnel no los haya declarado. Sin test de significancia: solo el aviso de
 * muestra chica. Cuando el test cierre se borra este archivo y su línea en
 * EmbudoView.
 */

import type { Funnel } from "@/lib/funnels";
import type { ExperimentoRow } from "@/lib/queries/funnel";
import { panelColors } from "@/tailwind.config";
import {
  Banner,
  Card,
  EmptyState,
  Table,
  fmtInt,
  fmtMoney,
  fmtPct,
} from "@/components/ui";

/** Los cuatro brazos en `sessions.experiment`, en el orden en que se muestran. */
export const BRAZOS_PORTADA = [
  "portada_a",
  "portada_b",
  "portada_c",
  "portada_d",
] as const;

/**
 * Sesiones por brazo por debajo de las cuales la diferencia en "pasaron la
 * portada" todavía es ruido. Con ~33 % de base, 400 por brazo separan una
 * diferencia de unos 8-10 puntos.
 */
export const MIN_SESIONES_PORTADA = 400;

const ETIQUETA: Record<
  string,
  { nombre: string; detalle: string; color: string }
> = {
  portada_a: {
    nombre: "A · Bajá la panza",
    detalle: "Bajá la panza y ganá fuerza en 28 días, con 15 minutos en casa",
    color: panelColors.acento,
  },
  portada_b: {
    nombre: "B · Plan para hombres",
    detalle: "Plan de calistenia rusa para hombres",
    color: panelColors.info,
  },
  portada_c: {
    nombre: "C · Después de los 40",
    detalle: "Después de los 40, la panza no se va con abdominales",
    color: panelColors.warn,
  },
  portada_d: {
    nombre: "D · Sin gimnasio",
    detalle: "Sin gimnasio ni pesas: el método ruso para bajar la panza en casa",
    color: panelColors.muted,
  },
};

const HINT =
  "Cada persona que entra al quiz ve uno de cuatro titulares en la primera pantalla (25 % cada uno); la pregunta, la foto y el resto del funnel son iguales. Cada persona ve siempre el mismo. Cuenta desde que vio la portada, así que también están los que se fueron sin tocar nada. Lo primero que mueve un titular es cuántos pasan la portada; la columna que decide al final es la plata por sesión. Las compras cuentan en el día en que empezó la sesión. Respeta los filtros de arriba.";

function esBrazoPortada(experiment: string): boolean {
  return (BRAZOS_PORTADA as readonly string[]).includes(experiment);
}

/** ¿Se muestra la card? PURA: el funnel declaró algún brazo, o llegaron sesiones con alguno. */
export function debeMostrarCardPortada(
  experimentsDeclarados: string[],
  filas: ExperimentoRow[],
): boolean {
  return (
    experimentsDeclarados.some(esBrazoPortada) ||
    filas.some((f) => esBrazoPortada(f.experiment) && f.sessions > 0)
  );
}

/** Las filas del test, de la A a la D. */
export function brazosPortada(filas: ExperimentoRow[]): ExperimentoRow[] {
  return BRAZOS_PORTADA.map((b) => filas.find((f) => f.experiment === b)).filter(
    (f): f is ExperimentoRow => f !== undefined,
  );
}

/** Pasaron la portada / sesiones, 0-100. 0 sin sesiones (nunca NaN). */
export function tasaPortada(r: ExperimentoRow): number {
  return r.sessions > 0 ? ((r.quizStarted ?? 0) / r.sessions) * 100 : 0;
}

/** El brazo que más pasa la portada. null con menos de dos brazos con sesiones, o empate. */
export function liderPortada(brazos: ExperimentoRow[]): ExperimentoRow | null {
  const con = brazos.filter((b) => b.sessions > 0);
  if (con.length < 2) return null;
  const ord = [...con].sort((a, b) => tasaPortada(b) - tasaPortada(a));
  return tasaPortada(ord[0]!) === tasaPortada(ord[1]!) ? null : ord[0]!;
}

/** true mientras falte un brazo o el más chico no llegue a MIN_SESIONES_PORTADA. */
export function muestraChicaPortada(brazos: ExperimentoRow[]): boolean {
  if (brazos.length < BRAZOS_PORTADA.length) return true;
  return Math.min(...brazos.map((b) => b.sessions)) < MIN_SESIONES_PORTADA;
}

export function CardTestPortada({
  funnel,
  filas,
}: {
  funnel: Funnel;
  filas: ExperimentoRow[];
}) {
  const brazos = brazosPortada(filas);
  const lider = liderPortada(brazos);
  const chica = muestraChicaPortada(brazos);
  const moneda = funnel.sellCurrency;

  return (
    <Card title="Test A/B/C/D: titulares de la portada" hint={HINT}>
      {brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones del test en este rango"
          hint="El test arrancó el 3/11. Si el rango es anterior, no hay nada que comparar."
        />
      ) : (
        <div className="space-y-5">
          {lider && (
            <p className="text-sm text-neutral-300">
              Va ganando{" "}
              <span className="font-semibold text-good-300">
                {ETIQUETA[lider.experiment]?.nombre ?? lider.experiment}
              </span>{" "}
              en pasar la portada{chica ? ", por ahora." : "."}
            </p>
          )}

          {chica && (
            <Banner tone="warn" title="Muestra chica: todavía es pronto para decidir">
              Hacen falta al menos{" "}
              <span className="font-semibold tabular-nums">
                {fmtInt(MIN_SESIONES_PORTADA)}
              </span>{" "}
              sesiones por titular, y{" "}
              {brazos.length < BRAZOS_PORTADA.length
                ? `por ahora llegaron ${brazos.length} de ${BRAZOS_PORTADA.length}.`
                : `el más chico tiene ${fmtInt(Math.min(...brazos.map((b) => b.sessions)))}.`}{" "}
              Los números son reales, pero la diferencia todavía puede darse
              vuelta sola.
            </Banner>
          )}

          <Table
            rows={brazos}
            empty="Sin datos"
            columns={[
              {
                key: "experiment",
                header: "Titular",
                render: (r) => (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          ETIQUETA[r.experiment]?.color ?? panelColors.muted,
                      }}
                    />
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium text-neutral-100">
                        {ETIQUETA[r.experiment]?.nombre ?? r.experiment}
                      </span>
                      {ETIQUETA[r.experiment] && (
                        <span className="max-w-[36ch] text-[11px] max-panel:text-xs text-neutral-500">
                          {ETIQUETA[r.experiment]!.detalle}
                        </span>
                      )}
                    </span>
                  </span>
                ),
              },
              {
                key: "sessions",
                header: "Vieron la portada",
                align: "right",
                render: (r) => fmtInt(r.sessions),
              },
              {
                key: "quizStarted",
                header: "Pasaron la portada",
                align: "right",
                render: (r) => (
                  <span className="flex flex-col items-end leading-tight">
                    <span
                      className={`font-semibold tabular-nums ${
                        lider?.experiment === r.experiment
                          ? "text-good-300"
                          : "text-neutral-50"
                      }`}
                    >
                      {r.sessions > 0 ? fmtPct(tasaPortada(r), 1) : "—"}
                    </span>
                    <span className="text-[11px] max-panel:text-xs tabular-nums text-neutral-500">
                      {fmtInt(r.quizStarted ?? 0)}/{fmtInt(r.sessions)}
                    </span>
                  </span>
                ),
              },
              {
                key: "salesViews",
                header: "Vieron la venta",
                align: "right",
                render: (r) => (
                  <span className="tabular-nums">
                    {fmtInt(r.salesViews)}{" "}
                    <span className="text-xs text-neutral-500">
                      ({fmtPct(r.pctSalesView, 0)})
                    </span>
                  </span>
                ),
              },
              {
                key: "purchases",
                header: "Compras",
                align: "right",
                render: (r) => fmtInt(r.purchases),
              },
              {
                key: "revenue",
                header: "Plata aprobada",
                align: "right",
                render: (r) => (
                  <span className="tabular-nums">{fmtMoney(r.revenue, moneda)}</span>
                ),
              },
              {
                key: "revenuePerSession",
                header: `${moneda}/sesión`,
                align: "right",
                render: (r) => (
                  <span className="tabular-nums">
                    {r.sessions > 0 ? fmtMoney(r.revenuePerSession, moneda) : "—"}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}
