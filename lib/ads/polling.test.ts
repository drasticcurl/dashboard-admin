import { describe, expect, it } from 'vitest';
import type { FrescuraAds } from './live';
import type { FrescuraJerarquia } from './liveJerarquia';
import { textoEdad } from './polling';

/**
 * Task 11 de frescura-y-acciones-anuncios: `textoEdadGasto` pasó a ser
 * `textoEdad` y ahora cuenta la antigüedad de las DOS sincronizaciones que el
 * panel muestra (R4.5).
 *
 * Lo que se fija acá es lo que la barra de frescura, el Resumen y el widget de
 * gasto de Ventas leen en pantalla, más las dos cosas que la generalización pone
 * en juego: que las dos frescuras entren por la misma firma, y que un error no se
 * lea como un dato fresco.
 */

/** El gasto: la forma de `lib/ads/live.ts`. */
function gasto(ageSeconds: number | null, error: string | null = null): FrescuraAds {
  return {
    syncedAt: ageSeconds === null ? null : new Date().toISOString(),
    ageSeconds,
    refreshed: false,
    error,
  };
}

/** La Jerarquía: la forma de `lib/ads/liveJerarquia.ts`. */
function jerarquia(ageSeconds: number | null, error: string | null = null): FrescuraJerarquia {
  return {
    syncedAt: ageSeconds === null ? null : new Date().toISOString(),
    ageSeconds,
    refreshed: false,
    error,
  };
}

describe('textoEdad', () => {
  it('sin frescura devuelve null, para que el llamador ponga su propio guion', () => {
    // `null` NO es "sincronizó recién" ni "está viejo": es "no hay dato". La barra
    // y el Resumen lo resuelven con `?? '—'`, y el widget de Ventas omite el sub.
    expect(textoEdad(null)).toBeNull();
    expect(textoEdad(undefined)).toBeNull();
  });

  it('una frescura que nunca sincronizó lo dice con palabras', () => {
    expect(textoEdad(gasto(null))).toBe('nunca sincronizado');
    // El caso real de la Jerarquía: `last_hierarchy_sync_at` en NULL hasta la
    // primera corrida del cron después de la migración 025.
    expect(textoEdad(jerarquia(null))).toBe('nunca sincronizado');
  });

  it('abajo de 90 segundos está al día, y no "hace 0 min"', () => {
    // Con el tick de cada minuto este es el caso NORMAL del gasto: contarlo en
    // minutos daría 0 o 1 y parecería un número roto.
    expect(textoEdad(gasto(0))).toBe('al día');
    expect(textoEdad(gasto(89))).toBe('al día');
  });

  it('los escalones son minutos, horas y días', () => {
    expect(textoEdad(gasto(90))).toBe('hace 2 min');
    expect(textoEdad(gasto(3599))).toBe('hace 60 min');
    expect(textoEdad(gasto(3600))).toBe('hace 1 h');
    expect(textoEdad(gasto(86_399))).toBe('hace 24 h');
    expect(textoEdad(gasto(86_400))).toBe('hace 1 d');
  });

  it('el error gana sobre la edad, incluso con una edad fresca', () => {
    // Es el punto del asunto: las dos frescuras avanzan su reloj TAMBIÉN cuando
    // la corrida falla (`last_sync_at`, `last_hierarchy_sync_at`), así que con un
    // error la edad dice cuándo se intentó y no de cuándo es el dato. Decir "al
    // día" ahí sería la mentira que este spec vino a sacar de la pantalla.
    expect(textoEdad(gasto(3, 'Meta devolvió 190: token vencido'))).toBe('sync con error');
    expect(textoEdad(jerarquia(3, 'rate limit'))).toBe('sync con error');
    // Y también cuando nunca sincronizó: el error es la información útil.
    expect(textoEdad(gasto(null, 'boom'))).toBe('sync con error');
  });

  it('las dos frescuras dicen lo mismo con la misma edad', () => {
    // La generalización de la firma en una línea: el mismo número entra por los
    // dos tipos y sale con las mismas palabras, que es lo que permite comparar
    // las dos edades de la barra de un vistazo. Que los dos tipos compilen contra
    // `FrescuraLeible` lo verifica tsc en las dos fábricas de arriba.
    for (const s of [0, 89, 90, 600, 3600, 90_000]) {
      expect(textoEdad(jerarquia(s))).toBe(textoEdad(gasto(s)));
    }
  });
});
