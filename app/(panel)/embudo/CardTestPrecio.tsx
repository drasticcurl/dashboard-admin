"use client";

/**
 * CardTestPrecio — el A/B de precio de los planes, en /embudo.
 *
 * Lo corre astratarot (Astra Tarot · quiz astral) desde el 2026-10-14: la
 * mitad de las sesiones paga el precio de siempre (Esencial $9.790, Completo
 * $13.790) y la otra mitad $2.000 más ($11.790 y $15.790). La oferta de
 * rescate y los upsells son los mismos en los dos. El grupo sale del id de la
 * sesión del quiz y viaja como `sessions.experiment` = `precio_a` | `precio_b`
 * (ver `funnel-manoxd/app/api/track/route.ts`): lo llevan los eventos desde
 * que arranca el quiz, así que las visitas que no lo empiezan quedan fuera.
 *
 * Mismo contrato que CardTestEstetica: lee `FunnelData.experiments` (sin
 * query propia), no recorta el resto de la pantalla, respeta los filtros de
 * arriba y no tiene test de significancia (conteos al lado de cada tasa y un
 * aviso mientras la muestra no alcance). Cuando el test cierre se borra este
 * archivo y su línea en EmbudoView.
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

/** Prefijo de los brazos de este test en `sessions.experiment`. */
export const PREFIJO_PRECIO = "precio_";

/** Compras por brazo por debajo de las cuales la diferencia todavía es ruido. */
export const MIN_COMPRAS_PRECIO = 100;

const ETIQUETA: Record<
  string,
  { nombre: string; detalle: string; color: string }
> = {
  precio_a: {
    nombre: "A · precio de siempre",
    detalle: "Esencial $9.790 · Completo $13.790",
    color: panelColors.info,
  },
  precio_b: {
    nombre: "B · +$2.000",
    detalle: "Esencial $11.790 · Completo $15.790",
    color: panelColors.acento,
  },
};

const HINT =
  "La mitad de las sesiones del quiz ve los planes al precio de siempre y la otra mitad $2.000 más caros; el resto (oferta de rescate, upsells) es igual. Cada persona ve siempre el mismo precio. La columna que decide es la plata por sesión: B puede convertir menos y aun así dejar más. Las compras cuentan en el día en que empezó la sesión. Respeta los filtros de arriba.";

/** ¿Se muestra la card? PURA: el funnel declaró algún brazo `precio_*`. */
export function debeMostrarCardPrecio(
  experimentsDeclarados: string[],
): boolean {
  return experimentsDeclarados.some((e) => e.startsWith(PREFIJO_PRECIO));
}

/** Las filas del test, A primero. Fuera `(sin asignar)` y los brazos de otros tests. */
export function brazosPrecio(filas: ExperimentoRow[]): ExperimentoRow[] {
  return filas
    .filter((f) => f.experiment.startsWith(PREFIJO_PRECIO))
    .sort((a, b) => a.experiment.localeCompare(b.experiment));
}

/** El brazo con más plata por sesión. null con menos de dos brazos con sesiones, o empate. */
export function liderPrecio(brazos: ExperimentoRow[]): ExperimentoRow | null {
  const con = brazos.filter((b) => b.sessions > 0);
  if (con.length < 2) return null;
  const ord = [...con].sort(
    (a, b) => b.revenuePerSession - a.revenuePerSession,
  );
  return ord[0]!.revenuePerSession === ord[1]!.revenuePerSession
    ? null
    : ord[0]!;
}

/** true mientras falte un brazo o el más chico no llegue a MIN_COMPRAS_PRECIO. */
export function muestraChicaPrecio(brazos: ExperimentoRow[]): boolean {
  if (brazos.length < 2) return true;
  return Math.min(...brazos.map((b) => b.purchases)) < MIN_COMPRAS_PRECIO;
}

export function CardTestPrecio({
  funnel,
  filas,
}: {
  funnel: Funnel;
  filas: ExperimentoRow[];
}) {
  const brazos = brazosPrecio(filas);
  const lider = liderPrecio(brazos);
  const fueraDelTest =
    filas.find((f) => f.experiment === SIN_EXPERIMENTO)?.sessions ?? 0;
  const moneda = funnel.sellCurrency;

  return (
    <Card title="Test A/B de precio" hint={HINT}>
      {brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones del test en este rango"
          hint="El test arrancó el 14/10 a las 16:55 (hora de Argentina). Si el rango es anterior, no hay nada que comparar."
        />
      ) : (
        <div className="space-y-5">
          {muestraChicaPrecio(brazos) && (
            <Banner
              tone="warn"
              title="Muestra chica: todavía no alcanza para decidir"
            >
              Hacen falta al menos{" "}
              <span className="font-semibold tabular-nums">
                {MIN_COMPRAS_PRECIO}
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
                header: "Precio",
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
                key: "sessions",
                header: "Sesiones",
                align: "right",
                render: (r) => fmtInt(r.sessions),
              },
              {
                key: "salesViews",
                header: "Llegó a la oferta",
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
                key: "pctCheckoutClick",
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
                key: "pctSessionToPurchase",
                header: "Conversión",
                align: "right",
                render: (r) => (
                  <span className="flex flex-col items-end leading-tight">
                    <span className="tabular-nums text-neutral-100">
                      {r.sessions > 0 ? fmtPct(r.pctSessionToPurchase, 2) : "—"}
                    </span>
                    <span className="text-[11px] max-panel:text-xs tabular-nums text-neutral-500">
                      {fmtInt(r.purchases)}/{fmtInt(r.sessions)}
                    </span>
                  </span>
                ),
              },
              {
                key: "revenue",
                header: "Facturación",
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
              sesiones fuera del test (visitas que no empezaron el quiz, o de
              antes de que arrancara): no entran en esta tabla.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
