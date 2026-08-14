/**
 * Tipos compartidos de la pantalla de reglas (T19).
 *
 * SÓLO TIPOS: este archivo no importa nada en runtime. Lo importan `page.tsx` y
 * los routes (server) para compartir el shape, y `ReglasView.tsx` (client) sólo
 * con `import type`. Si acá entrara un import de `lib/db` (pg), el bundle del
 * browser arrastraría el cliente de Postgres — igual que el warning de
 * `ConfigView.tsx`.
 */

import type { Condicion, Regla } from '@/lib/ads/tipos';

/** Una regla tal como la lista la pantalla: el contrato de §5 más condiciones y timestamps. */
export type ReglaFila = Regla & {
  condiciones: Condicion[];
  lastRunAt: string | null;
  lastRunError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CuentaAds = {
  accountId: string;
  name: string | null;
};

/**
 * El estado completo de los interruptores globales + el estado del worker, que
 * es lo que el banner de arriba de la lista muestra. Nunca incluye el token de
 * Telegram ni ninguna otra fila de `settings`.
 */
export type EstadoInterruptores = {
  habilitado: boolean;
  forzarSombra: boolean;
  ttlSegundos: number;
  maxDailyBudgetEur: number;
  maxDeltaPorTickEur: number;
  backoffUntil: string | null;
  backoffReason: string | null;
  backoffFailures: number;
  workerLastTick: string | null;
};
