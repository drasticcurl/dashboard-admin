import { describe, expect, it } from "vitest";
import { calcularTasasExperimento } from "@/lib/queries/funnel";
import {
  brazosPortada,
  debeMostrarCardPortada,
  liderPortada,
  muestraChicaPortada,
  tasaPortada,
} from "./CardTestPortada";

const fila = (experiment: string, sessions: number, quizStarted: number) =>
  calcularTasasExperimento([
    {
      experiment,
      sessions,
      quizStarted,
      salesViews: 0,
      checkoutClicks: 0,
      purchases: 0,
      upsellViews: 0,
      upsellClicks: 0,
      downsellViews: 0,
      revenue: 0,
    },
  ])[0]!;

describe("CardTestPortada", () => {
  const filas = [
    fila("(sin asignar)", 900, 300),
    fila("portada_c", 100, 40),
    fila("portada_a", 100, 30),
    fila("vsl", 50, 50),
  ];

  it("se muestra solo con filas de la portada o brazos declarados", () => {
    expect(debeMostrarCardPortada([], filas)).toBe(true);
    expect(debeMostrarCardPortada([], [fila("vsl", 10, 5)])).toBe(false);
    expect(debeMostrarCardPortada(["portada_a"], [])).toBe(true);
  });

  it("ordena A→D y deja afuera el resto", () => {
    expect(brazosPortada(filas).map((f) => f.experiment)).toEqual(["portada_a", "portada_c"]);
  });

  it("la tasa es pasaron / vieron la portada, sin NaN", () => {
    expect(tasaPortada(fila("portada_a", 200, 50))).toBe(25);
    expect(tasaPortada(fila("portada_a", 0, 0))).toBe(0);
  });

  it("lidera el que más pasa la portada; muestra chica hasta 400 por brazo en los cuatro", () => {
    const b = brazosPortada(filas);
    expect(liderPortada(b)?.experiment).toBe("portada_c");
    expect(muestraChicaPortada(b)).toBe(true);
    const llenos = ["a", "b", "c", "d"].map((x) => fila(`portada_${x}`, 400, 130));
    expect(muestraChicaPortada(llenos)).toBe(false);
    expect(liderPortada(llenos)).toBeNull();
  });
});
