/**
 * Property 1: La Hora_Local coincide con la de PostgreSQL, saltos de horario
 * incluidos (spec reglas-anuncios-por-cuenta, task 1.2).
 *
 * El oráculo es PostgreSQL (`to_char(instante AT TIME ZONE zona, 'HH24:MI')`),
 * no `horaLocalEn`: la autoridad de las fechas en este proyecto es la base, y
 * un test que se compara consigo mismo pasa igual con un `horaLocalEn` roto.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { q1 } from '../db';
import { horaLocalEn } from './zona';
import { ZONAS_P16 } from '../test/generadores-ads';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const AHORA = Date.now();
const DOS_ANIOS_MS = 2 * 365.25 * 24 * 3_600_000;
const FECHA_MIN = new Date(AHORA - DOS_ANIOS_MS);
const FECHA_MAX = new Date(AHORA + DOS_ANIOS_MS);

describe.skipIf(!dbAvailable)('horaLocalEn contra PostgreSQL (Property 1)', () => {
  it('para todo instante en ±2 años y toda zona del proyecto, coincide con to_char(AT TIME ZONE)', async () => {
    // Feature: reglas-anuncios-por-cuenta, Property 1: La Hora_Local coincide con
    // la de PostgreSQL, saltos de horario incluidos
    await fc.assert(
      fc.asyncProperty(
        fc.date({ min: FECHA_MIN, max: FECHA_MAX, noInvalidDate: true }),
        fc.constantFrom(...ZONAS_P16),
        async (fecha, zona) => {
          // El instante viaja como ISO 8601 con offset, no como Date: el driver
          // de pg serializa los Date en la hora LOCAL del proceso y el instante
          // se correría (lib/day.ts). El `::timestamptz` conserva el instante.
          const r = await q1<{ hh: string }>(
            `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hh`,
            [fecha.toISOString(), zona],
          );
          expect(horaLocalEn(zona, fecha)).toBe(r?.hh);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('los saltos de DST de 2026 en Lisboa: la hora inexistente y la repetida', async () => {
    const casos: Array<{ zona: string; fecha: Date; espera: string }> = [
      // Lisboa salta 01:00 → 02:00 el 2026-03-29: la 01:xx no existe.
      { zona: 'Europe/Lisbon', fecha: new Date('2026-03-29T00:59:59Z'), espera: '00:59' },
      { zona: 'Europe/Lisbon', fecha: new Date('2026-03-29T01:00:00Z'), espera: '02:00' },
      { zona: 'Europe/Lisbon', fecha: new Date('2026-03-29T01:30:00Z'), espera: '02:30' },
      // Lisboa retrocede 02:00+01 → 01:00+00 el 2026-10-25: la 01:xx se repite.
      { zona: 'Europe/Lisbon', fecha: new Date('2026-10-25T00:59:59Z'), espera: '01:59' },
      { zona: 'Europe/Lisbon', fecha: new Date('2026-10-25T01:00:00Z'), espera: '01:00' },
      { zona: 'Europe/Lisbon', fecha: new Date('2026-10-25T01:30:00Z'), espera: '01:30' },
      // Buenos Aires no tiene DST desde 2009: los mismos instantes son horas
      // normales, y el oráculo tiene que decir lo mismo que Intl igual.
      { zona: 'America/Argentina/Buenos_Aires', fecha: new Date('2026-03-29T03:30:00Z'), espera: '00:30' },
      { zona: 'America/Argentina/Buenos_Aires', fecha: new Date('2026-10-25T03:30:00Z'), espera: '00:30' },
    ];
    for (const { zona, fecha, espera } of casos) {
      const r = await q1<{ hh: string }>(
        `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hh`,
        [fecha.toISOString(), zona],
      );
      expect(r?.hh).toBe(espera);
      expect(horaLocalEn(zona, fecha)).toBe(espera);
    }
  });
});
