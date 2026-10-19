import { describe, expect, it } from "vitest";
import type { ExperimentoRow } from "@/lib/queries/funnel";
import { calcularTasasExperimento } from "@/lib/queries/funnel";
import {
  brazosChat,
  debeMostrarCardChat,
  liderChat,
  muestraChicaChat,
} from "./CardTestChat";

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

describe("CardTestChat", () => {
  it("aparece solo si el funnel declara brazos chat_*", () => {
    expect(debeMostrarCardChat(["precio_a", "chat_whatsapp", "chat_mistico"])).toBe(true);
    expect(debeMostrarCardChat(["estetica_original", "precio_a"])).toBe(false);
    expect(debeMostrarCardChat([])).toBe(false);
  });

  it("solo sus brazos, WhatsApp primero", () => {
    const filas = [
      fila("chat_mistico", 100, 3, 300),
      fila("estetica_tarot", 50, 1, 100),
      fila("chat_whatsapp", 100, 2, 200),
    ];
    expect(brazosChat(filas).map((f) => f.experiment)).toEqual(["chat_whatsapp", "chat_mistico"]);
  });

  it("gana el de más plata por sesión; con muestra chica avisa", () => {
    const wa = fila("chat_whatsapp", 100, 2, 200);
    const mi = fila("chat_mistico", 100, 3, 300);
    expect(liderChat([wa, mi])?.experiment).toBe("chat_mistico");
    expect(muestraChicaChat([wa, mi])).toBe(true);
  });
});
