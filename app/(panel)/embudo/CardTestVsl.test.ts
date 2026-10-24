import { describe, expect, it } from "vitest";
import type { ExperimentoRow } from "@/lib/queries/funnel";
import { calcularTasasExperimento } from "@/lib/queries/funnel";
import { SIN_EXPERIMENTO } from "@/lib/experimento";
import {
  MIN_COMPRAS_VSL,
  brazosVsl,
  debeMostrarCardVsl,
  liderVsl,
  muestraChicaVsl,
  tasaCompraVsl,
} from "./CardTestVsl";

function fila(
  experiment: string,
  salesViews: number,
  purchases: number,
  revenue: number,
): ExperimentoRow {
  return calcularTasasExperimento([
    {
      experiment,
      // El experimento se manda desde sales_view: sesiones ≈ vieron la venta.
      sessions: salesViews,
      salesViews,
      checkoutClicks: purchases * 2,
      purchases,
      upsellViews: 0,
      upsellClicks: 0,
      downsellViews: 0,
      revenue,
    },
  ])[0]!;
}

describe("CardTestVsl", () => {
  it("aparece si el funnel declara los brazos o si llegaron filas con ellos", () => {
    expect(debeMostrarCardVsl(["vsl", "sin-vsl"], [])).toBe(true);
    expect(debeMostrarCardVsl([], [fila("sin-vsl", 10, 0, 0)])).toBe(true);
    expect(debeMostrarCardVsl([], [fila(SIN_EXPERIMENTO, 10, 1, 10)])).toBe(false);
    expect(debeMostrarCardVsl(["chat_whatsapp"], [fila("chat_mistico", 10, 1, 10)])).toBe(false);
    expect(debeMostrarCardVsl([], [fila("vsl", 0, 0, 0)])).toBe(false);
    expect(debeMostrarCardVsl([], [])).toBe(false);
  });

  it("solo sus brazos, con VSL primero", () => {
    const filas = [
      fila(SIN_EXPERIMENTO, 500, 3, 300),
      fila("sin-vsl", 100, 2, 200),
      fila("chat_mistico", 50, 1, 100),
      fila("vsl", 100, 3, 300),
    ];
    expect(brazosVsl(filas).map((f) => f.experiment)).toEqual(["vsl", "sin-vsl"]);
    expect(brazosVsl([fila("sin-vsl", 10, 0, 0)]).map((f) => f.experiment)).toEqual(["sin-vsl"]);
  });

  it("tasa de compra = compras / vieron la venta, sin NaN", () => {
    expect(tasaCompraVsl(fila("vsl", 200, 5, 0))).toBeCloseTo(2.5);
    expect(tasaCompraVsl(fila("vsl", 0, 0, 0))).toBe(0);
  });

  it("gana el de más plata por sesión aunque venda menos", () => {
    const con = fila("vsl", 100, 2, 300); // 3 por sesión (upsells)
    const sin = fila("sin-vsl", 100, 3, 250); // 2,5 por sesión
    expect(liderVsl([con, sin])?.experiment).toBe("vsl");
  });

  it("sin líder con un solo brazo o empate", () => {
    expect(liderVsl([fila("vsl", 100, 2, 200)])).toBeNull();
    expect(liderVsl([fila("vsl", 100, 2, 200), fila("sin-vsl", 100, 2, 200)])).toBeNull();
  });

  it("avisa muestra chica hasta que los dos brazos llegan al mínimo", () => {
    const n = MIN_COMPRAS_VSL;
    expect(muestraChicaVsl([fila("vsl", 9000, n + 10, 1)])).toBe(true);
    expect(muestraChicaVsl([fila("vsl", 9000, n + 10, 1), fila("sin-vsl", 9000, n - 1, 1)])).toBe(true);
    expect(muestraChicaVsl([fila("vsl", 9000, n, 1), fila("sin-vsl", 9000, n, 1)])).toBe(false);
  });
});
