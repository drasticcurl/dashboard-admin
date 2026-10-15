import { describe, expect, it } from "vitest";
import type { ExperimentoRow } from "@/lib/queries/funnel";
import {
  calcularTasasExperimento,
  SIN_EXPERIMENTO,
} from "@/lib/queries/funnel";
import {
  brazosPrecio,
  debeMostrarCardPrecio,
  liderPrecio,
  muestraChicaPrecio,
} from "./CardTestPrecio";

function fila(
  experiment: string,
  sessions: number,
  purchases: number,
  revenue: number,
): ExperimentoRow {
  return calcularTasasExperimento([
    {
      experiment,
      sessions,
      salesViews: Math.round(sessions / 2),
      checkoutClicks: purchases * 2,
      purchases,
      upsellViews: 0,
      upsellClicks: 0,
      downsellViews: 0,
      revenue,
    },
  ])[0]!;
}

describe("CardTestPrecio", () => {
  it("aparece solo si el funnel declara brazos precio_*", () => {
    expect(debeMostrarCardPrecio(["precio_a", "precio_b"])).toBe(true);
    expect(debeMostrarCardPrecio(["estetica_original"])).toBe(false);
    expect(debeMostrarCardPrecio([])).toBe(false);
  });

  it("solo los brazos del test, A primero", () => {
    const filas = [
      fila("precio_b", 10, 1, 100),
      fila(SIN_EXPERIMENTO, 50, 0, 0),
      fila("precio_a", 10, 1, 90),
    ];
    expect(brazosPrecio(filas).map((f) => f.experiment)).toEqual([
      "precio_a",
      "precio_b",
    ]);
  });

  it("gana la plata por sesión aunque convierta menos", () => {
    const a = fila("precio_a", 1000, 50, 50 * 13790);
    const b = fila("precio_b", 1000, 45, 45 * 15790);
    expect(liderPrecio([a, b])?.experiment).toBe("precio_b");
  });

  it("muestra chica con un solo brazo o pocas compras", () => {
    expect(muestraChicaPrecio([fila("precio_a", 10, 200, 1)])).toBe(true);
    expect(
      muestraChicaPrecio([
        fila("precio_a", 10, 99, 1),
        fila("precio_b", 10, 200, 1),
      ]),
    ).toBe(true);
    expect(
      muestraChicaPrecio([
        fila("precio_a", 10, 100, 1),
        fila("precio_b", 10, 100, 1),
      ]),
    ).toBe(false);
  });
});
