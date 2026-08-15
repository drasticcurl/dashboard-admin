/**
 * El tope agregado de presupuesto por Tick (D-A9c), ahora POR CUENTA.
 *
 * TECHO EFECTIVO: `ads_max_delta_por_tick_eur` × cantidad de Cuenta_Activa. Con
 * el valor actual de 300 y 2 cuentas activas, el módulo puede sumar hasta €600
 * de presupuesto diario nuevo en un mismo Tick. Antes de esta spec el tope era
 * uno solo para todo el Tick (€300), y la primera cuenta que lo agotaba
 * bloqueaba las subidas de la otra.
 *
 * Puro: sin base, sin red. `sumado` y `topeMin` van en unidades mínimas.
 */
export type AcumuladorDelta = { sumado: number; topeMin: number };

/** Un acumulador por cuenta activa, todos en cero (R7 c1). */
export function crearAcumuladores(accountIds: string[], topeEur: number): Map<string, AcumuladorDelta> {
  const mapa = new Map<string, AcumuladorDelta>();
  for (const id of accountIds) {
    mapa.set(id, { sumado: 0, topeMin: Math.round(topeEur * 100) });
  }
  return mapa;
}

/** El de esa cuenta. Si no está (cuenta desactivada a mitad de Tick), lo crea. */
export function acumuladorDe(
  mapa: Map<string, AcumuladorDelta>,
  accountId: string,
  topeEur: number,
): AcumuladorDelta {
  const existente = mapa.get(accountId);
  if (existente) return existente;
  const nuevo = { sumado: 0, topeMin: Math.round(topeEur * 100) };
  mapa.set(accountId, nuevo);
  return nuevo;
}

/**
 * true = cabe y se sumó; false = no cabe y el acumulador queda INTACTO.
 *
 * Un delta ≤ 0 devuelve true sin sumar: sólo las subidas consumen tope, igual
 * que antes. Es una sola función y no un `cabe()` + un `sumar()` porque dos
 * funciones son cómo el chequeo y la suma se desincronizan en la próxima
 * edición.
 */
export function aplicarDelta(a: AcumuladorDelta, deltaMin: number): boolean {
  if (deltaMin <= 0) return true;
  if (a.sumado + deltaMin > a.topeMin) return false;
  a.sumado += deltaMin;
  return true;
}
