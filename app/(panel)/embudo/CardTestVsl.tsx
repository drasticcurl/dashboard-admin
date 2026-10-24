"use client";

/**
 * CardTestVsl — el A/B de la página de venta de calistenia-rusa-28, en /embudo.
 *
 * La mitad de las sesiones que llegan a la venta la ve con el VSL arriba y la
 * otra mitad sin video (`NEXT_PUBLIC_VSL_AB=1` en el funnel). El grupo viaja
 * como `sessions.experiment` = `vsl` | `sin-vsl` y se manda desde `sales_view`
 * en adelante: las sesiones que no llegaron a la venta caen en `(sin asignar)`.
 * Por eso la tasa que importa acá es compras / vieron la venta, y no compras /
 * sesiones del funnel entero.
 *
 * Mismo contrato que CardTestChat: lee `FunnelData.experiments`, no recorta
 * el resto de la pantalla, respeta los filtros de arriba y no tiene test de
 * significancia (solo el aviso de muestra chica). A diferencia de las otras,
 * aparece también cuando el funnel no declaró los brazos pero llegaron filas
 * con ellos: un funnel con `experiments` vacío no valida la dimensión en el
 * ingest. Cuando el test cierre se borra este archivo y su línea en EmbudoView.
 */

import type { Funnel } from "@/lib/funnels";
import type { ExperimentoRow } from "@/lib/queries/funnel";
import { SIN_EXPERIMENTO } from "@/lib/experimento";
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

/** Los dos brazos del test en `sessions.experiment`, en el orden en que se muestran. */
export const BRAZOS_VSL = ["vsl", "sin-vsl"] as const;

/**
 * Compras por brazo por debajo de las cuales la diferencia todavía es ruido.
 * El mismo umbral que los otros tests de esta pantalla.
 */
export const MIN_COMPRAS_VSL = 100;

const ETIQUETA: Record<
  string,
  { nombre: string; detalle: string; color: string }
> = {
  vsl: {
    nombre: "Con VSL",
    detalle: "video arriba de la venta",
    color: panelColors.acento,
  },
  "sin-vsl": {
    nombre: "Sin VSL",
    detalle: "la venta sin video",
    color: panelColors.info,
  },
};

const HINT =
  "La mitad de las sesiones que llegan a la página de venta la ve con el VSL y la otra mitad sin video; oferta, precio y upsells son iguales. Cada persona ve siempre la misma. Cuenta desde que vio la venta, así que la tasa de compra es compras / vieron la venta. La columna que decide es la plata por sesión (incluye upsells y descuenta lo no aprobado). Las compras cuentan en el día en que empezó la sesión. Respeta los filtros de arriba.";

function esBrazoVsl(experiment: string): boolean {
  return (BRAZOS_VSL as readonly string[]).includes(experiment);
}

/**
 * ¿Se muestra la card? PURA: el funnel declaró algún brazo del test, o en el
 * rango llegaron sesiones con alguno.
 */
export function debeMostrarCardVsl(
  experimentsDeclarados: string[],
  filas: ExperimentoRow[],
): boolean {
  return (
    experimentsDeclarados.some(esBrazoVsl) ||
    filas.some((f) => esBrazoVsl(f.experiment) && f.sessions > 0)
  );
}

/** Las filas del test, con VSL primero. Fuera `(sin asignar)` y los brazos de otros tests. */
export function brazosVsl(filas: ExperimentoRow[]): ExperimentoRow[] {
  return BRAZOS_VSL.map((b) => filas.find((f) => f.experiment === b)).filter(
    (f): f is ExperimentoRow => f !== undefined,
  );
}

/** Compras / vieron la venta, 0-100. 0 si nadie vio la venta (nunca NaN). */
export function tasaCompraVsl(r: ExperimentoRow): number {
  return r.salesViews > 0 ? (r.purchases / r.salesViews) * 100 : 0;
}

/** El brazo con más plata por sesión. null con menos de dos brazos con sesiones, o empate. */
export function liderVsl(brazos: ExperimentoRow[]): ExperimentoRow | null {
  const con = brazos.filter((b) => b.sessions > 0);
  if (con.length < 2) return null;
  const ord = [...con].sort(
    (a, b) => b.revenuePerSession - a.revenuePerSession,
  );
  return ord[0]!.revenuePerSession === ord[1]!.revenuePerSession
    ? null
    : ord[0]!;
}

/** true mientras falte un brazo o el más chico no llegue a MIN_COMPRAS_VSL. */
export function muestraChicaVsl(brazos: ExperimentoRow[]): boolean {
  if (brazos.length < 2) return true;
  return Math.min(...brazos.map((b) => b.purchases)) < MIN_COMPRAS_VSL;
}

export function CardTestVsl({
  funnel,
  filas,
}: {
  funnel: Funnel;
  filas: ExperimentoRow[];
}) {
  const brazos = brazosVsl(filas);
  const lider = liderVsl(brazos);
  const fueraDelTest =
    filas.find((f) => f.experiment === SIN_EXPERIMENTO)?.sessions ?? 0;
  const moneda = funnel.sellCurrency;

  return (
    <Card title="Test A/B: con VSL vs sin VSL" hint={HINT}>
      {brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones del test en este rango"
          hint="Las sesiones entran al test recién cuando ven la página de venta. Si el rango es anterior al arranque, no hay nada que comparar."
        />
      ) : (
        <div className="space-y-5">
          {lider && (
            <p className="text-sm text-neutral-300">
              Va ganando{" "}
              <span className="font-semibold text-good-300">
                {ETIQUETA[lider.experiment]?.nombre ?? lider.experiment}
              </span>{" "}
              por plata por sesión
              {muestraChicaVsl(brazos) ? ", por ahora." : "."}
            </p>
          )}

          {muestraChicaVsl(brazos) && (
            <Banner
              tone="warn"
              title="Muestra chica: todavía es pronto para decidir"
            >
              Hacen falta al menos{" "}
              <span className="font-semibold tabular-nums">
                {MIN_COMPRAS_VSL}
              </span>{" "}
              compras por brazo, y{" "}
              {brazos.length < 2
                ? "por ahora llegó uno solo."
                : `el más chico tiene ${fmtInt(Math.min(...brazos.map((b) => b.purchases)))}.`}{" "}
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
                header: "Venta",
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
                        <span className="text-[11px] max-panel:text-xs text-neutral-500">
                          {ETIQUETA[r.experiment]!.detalle}
                        </span>
                      )}
                    </span>
                  </span>
                ),
              },
              {
                key: "salesViews",
                header: "Vieron la venta",
                align: "right",
                render: (r) => fmtInt(r.salesViews),
              },
              {
                key: "checkoutClicks",
                header: "Tocó pagar",
                align: "right",
                render: (r) => (
                  <span className="tabular-nums">
                    {fmtInt(r.checkoutClicks)}{" "}
                    <span className="text-xs text-neutral-500">
                      ({fmtPct(r.pctCheckoutClick, 0)})
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
                key: "pctPurchase",
                header: "Tasa de compra",
                align: "right",
                render: (r) => (
                  <span className="flex flex-col items-end leading-tight">
                    <span className="tabular-nums text-neutral-100">
                      {r.salesViews > 0 ? fmtPct(tasaCompraVsl(r), 2) : "—"}
                    </span>
                    <span className="text-[11px] max-panel:text-xs tabular-nums text-neutral-500">
                      {fmtInt(r.purchases)}/{fmtInt(r.salesViews)}
                    </span>
                  </span>
                ),
              },
              {
                key: "revenue",
                header: "Plata aprobada",
                align: "right",
                render: (r) => (
                  <span className="tabular-nums">
                    {fmtMoney(r.revenue, moneda)}
                  </span>
                ),
              },
              {
                key: "revenuePerSession",
                header: `${moneda}/sesión`,
                align: "right",
                render: (r) => (
                  <span
                    className={`font-semibold tabular-nums ${
                      lider?.experiment === r.experiment
                        ? "text-good-300"
                        : "text-neutral-50"
                    }`}
                  >
                    {r.sessions > 0
                      ? fmtMoney(r.revenuePerSession, moneda)
                      : "—"}
                  </span>
                ),
              },
            ]}
          />

          {fueraDelTest > 0 && (
            <p className="max-w-[70ch] text-pretty text-xs leading-relaxed text-neutral-500">
              Además hubo{" "}
              <span className="tabular-nums">{fmtInt(fueraDelTest)}</span>{" "}
              sesiones fuera del test (no llegaron a la venta, o son de antes de
              que arrancara): no entran en esta tabla.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
