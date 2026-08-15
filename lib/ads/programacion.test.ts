import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { q1 } from '../db';
import { mananaMedianoche, resolverInicio } from './programacion';
import { genFechaHoraZona } from '../test/generadores-ads';

/**
 * Tests de ejemplo de la programación del inicio (task 8.3). Necesitan
 * PostgreSQL: la aritmética se resuelve con AT TIME ZONE (design §11). La
 * Property 16 (instante único para toda fecha/hora/zona) vive en la task 8.2.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

describe.skipIf(!dbAvailable)('mananaMedianoche (R11 c2)', () => {
  it('mañana a las 00:00 en la Zona_Cuenta, con y sin DST', async () => {
    for (const zona of ['Europe/Lisbon', 'America/Argentina/Buenos_Aires']) {
      const r = await mananaMedianoche(zona);
      expect(r.hora).toBe('00:00');
      expect(r.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // fecha = hoy en la zona + 1 día, verificado por una vía independiente
      const esperada = await q1<{ fecha: string }>(
        `SELECT ((now() AT TIME ZONE $1)::date + 1)::text AS fecha`,
        [zona],
      );
      expect(r.fecha).toBe(esperada!.fecha);
    }
  });
});

describe.skipIf(!dbAvailable)('resolverInicio (R11 c4, c12)', () => {
  it('un día normal: instante con offset explícito y segundos en 00', async () => {
    const r = await resolverInicio('2026-06-15', '10:15', 'Europe/Lisbon');
    expect(r.instante).toBe('2026-06-15T10:15:00+01:00');
    expect(r.efectivo).toBe('2026-06-15T10:15:00');
    expect(r.ajustadoPorDst).toBe(false);
  });

  it('la hora inexistente del salto hacia adelante resuelve al primer instante posterior e informa el efectivo', async () => {
    // America/New_York salta 02:00 → 03:00 el 2026-03-08: las 02:30 no existen.
    const r = await resolverInicio('2026-03-08', '02:30', 'America/New_York');
    expect(r.ajustadoPorDst).toBe(true);
    expect(r.instante).toBe('2026-03-08T03:30:00-04:00');
    expect(r.efectivo).toBe('2026-03-08T03:30:00');
  });

  it('hueco de Lisboa: la hora de pared se conserva con el offset posterior al cambio', async () => {
    // Europe/Lisbon salta 02:00 → 03:00 el 2026-03-29. PostgreSQL resuelve las
    // 02:30 al primer instante posterior al cambio cuya pared lee 02:30.
    const r = await resolverInicio('2026-03-29', '02:30', 'Europe/Lisbon');
    expect(r.instante).toBe('2026-03-29T02:30:00+01:00');
    expect(r.ajustadoPorDst).toBe(false);
  });

  it('la hora repetida del salto hacia atrás resuelve a la aparición posterior al cambio', async () => {
    // Europe/Lisbon retrocede 02:00+01 → 01:00+00 el 2026-10-25: la 01:30
    // existe dos veces. Vale la segunda aparición (posterior al cambio).
    const r = await resolverInicio('2026-10-25', '01:30', 'Europe/Lisbon');
    expect(r.instante).toBe('2026-10-25T01:30:00+00:00');
  });

  it('la zona sin DST nunca ajusta', async () => {
    for (const fecha of ['2026-03-29', '2026-10-25']) {
      const r = await resolverInicio(fecha, '02:30', 'America/Argentina/Buenos_Aires');
      expect(r.ajustadoPorDst).toBe(false);
      expect(r.instante).toBe(`${fecha}T02:30:00-03:00`);
    }
  });

  it('fecha u hora inválidas se rechazan (bug del llamador)', async () => {
    await expect(resolverInicio('29/03/2026', '02:30', 'Europe/Lisbon')).rejects.toThrow();
    await expect(resolverInicio('2026-03-29', '2:30', 'Europe/Lisbon')).rejects.toThrow();
  });
});

/** La pared del instante resuelto en su zona, verificada por una vía
 *  independiente (AT TIME ZONE de Postgres). */
async function paredDe(instante: string, zona: string): Promise<string> {
  const r = await q1<{ pared: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD"T"HH24:MI:SS') AS pared`,
    [instante, zona],
  );
  return r!.pared;
}

// Feature: gestion-campanas-anuncios, Property 16: El inicio programado se
// resuelve a un instante único
describe.skipIf(!dbAvailable)('Property 16 (R11 c4, c12)', () => {
  it('para toda fecha, hora y zona, el instante es único, con offset explícito y segundos en 00, y la ida y vuelta conserva la pared salvo ajuste', async () => {
    await fc.assert(
      fc.asyncProperty(genFechaHoraZona(), async ({ fecha, hora, zona }) => {
        const r = await resolverInicio(fecha, hora, zona);

        // ISO 8601 con desplazamiento explícito y segundos en 00
        expect(r.instante).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);

        // la pared del instante resuelto en su zona
        const pared = await paredDe(r.instante, zona);
        if (!r.ajustadoPorDst) {
          // sin ajuste: la ida y vuelta devuelve la MISMA hora de pared
          expect(pared.slice(11, 16), `${fecha} ${hora} ${zona} → ${r.instante}`).toBe(hora);
        }

        // el efectivo informado ES la pared del instante enviado, siempre
        expect(r.efectivo).toBe(pared);
      }),
      { numRuns: 100 },
    );
  });
});
