"use client";

/**
 * CardTestChat — el A/B de estética del chat de almagemela, en /embudo.
 *
 * Desde el 2026-10-19 la mitad de las sesiones del funnel argentino ve el chat
 * de siempre, como WhatsApp, y la otra mitad el MISMO chat (guion, audios,
 * oferta y precio) con estética mística violeta y dorada, donde además los
 * "SI" se tocan en vez de tipearse. El grupo sale del id de la sesión y viaja
 * como `sessions.experiment` = `chat_whatsapp` | `chat_mistico` (ver
 * `nuevo-quiz-funnel/lib/chat-test.ts`) desde el primer paso del quiz, así que
 * cuenta a todas las que arrancan, lleguen o no al chat.
 *
 * Mismo contrato que CardTestChat: lee `FunnelData.experiments`, no recorta
 * el resto de la pantalla, respeta los filtros de arriba y no tiene test de
 * significancia. Cuando el test cierre se borra este archivo y su línea en
 * EmbudoView.
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
export const PREFIJO_CHAT = "chat_";

/** Compras por brazo por debajo de las cuales la diferencia todavía es ruido. */
export const MIN_COMPRAS_CHAT = 100;

const ETIQUETA: Record<
  string,
  { nombre: string; detalle: string; color: string }
> = {
  chat_whatsapp: {
    nombre: "WhatsApp",
    detalle: "el chat de siempre",
    color: panelColors.info,
  },
  chat_mistico: {
    nombre: "Místico",
    detalle: "violeta y dorado · el SI se toca",
    color: panelColors.acento,
  },
};

const HINT =
  "La mitad de las sesiones ve el chat del Maestro Zion como WhatsApp y la otra mitad el mismo chat con estética mística (violeta y dorado, y el SI es un botón); guion, audios, oferta y precio son iguales. Cada persona ve siempre el mismo. Cuenta desde el primer paso del quiz, así que «Llegó a la oferta» muestra cuántas terminaron el chat. La columna que decide es la plata por sesión. Las compras cuentan en el día en que empezó la sesión. Respeta los filtros de arriba.";

/** ¿Se muestra la card? PURA: el funnel declaró algún brazo `chat_*`. */
export function debeMostrarCardChat(
  experimentsDeclarados: string[],
): boolean {
  return experimentsDeclarados.some((e) => e.startsWith(PREFIJO_CHAT));
}

/** Las filas del test, WhatsApp primero. Fuera `(sin asignar)` y los brazos de otros tests. */
export function brazosChat(filas: ExperimentoRow[]): ExperimentoRow[] {
  return filas
    .filter((f) => f.experiment.startsWith(PREFIJO_CHAT))
    .sort((a, b) => b.experiment.localeCompare(a.experiment));
}

/** El brazo con más plata por sesión. null con menos de dos brazos con sesiones, o empate. */
export function liderChat(brazos: ExperimentoRow[]): ExperimentoRow | null {
  const con = brazos.filter((b) => b.sessions > 0);
  if (con.length < 2) return null;
  const ord = [...con].sort(
    (a, b) => b.revenuePerSession - a.revenuePerSession,
  );
  return ord[0]!.revenuePerSession === ord[1]!.revenuePerSession
    ? null
    : ord[0]!;
}

/** true mientras falte un brazo o el más chico no llegue a MIN_COMPRAS_CHAT. */
export function muestraChicaChat(brazos: ExperimentoRow[]): boolean {
  if (brazos.length < 2) return true;
  return Math.min(...brazos.map((b) => b.purchases)) < MIN_COMPRAS_CHAT;
}

export function CardTestChat({
  funnel,
  filas,
}: {
  funnel: Funnel;
  filas: ExperimentoRow[];
}) {
  const brazos = brazosChat(filas);
  const lider = liderChat(brazos);
  const fueraDelTest =
    filas.find((f) => f.experiment === SIN_EXPERIMENTO)?.sessions ?? 0;
  const moneda = funnel.sellCurrency;

  return (
    <Card title="Test A/B del chat" hint={HINT}>
      {brazos.length === 0 ? (
        <EmptyState
          title="No hay sesiones del test en este rango"
          hint="El test arrancó el 19/10 (hora de Argentina). Si el rango es anterior, no hay nada que comparar."
        />
      ) : (
        <div className="space-y-5">
          {muestraChicaChat(brazos) && (
            <Banner
              tone="warn"
              title="Muestra chica: todavía no alcanza para decidir"
            >
              Hacen falta al menos{" "}
              <span className="font-semibold tabular-nums">
                {MIN_COMPRAS_CHAT}
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
                header: "Chat",
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
              sesiones fuera del test (visitas sin cookie de sesión, o de antes
              de que arrancara): no entran en esta tabla.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
