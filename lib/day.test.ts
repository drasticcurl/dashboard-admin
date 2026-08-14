import { describe, expect, it } from 'vitest';
import { resolveRange, today, type RangePreset } from './day';

/**
 * Los tests de día necesitan la base (toda la aritmética vive en SQL): si no
 * hay DATABASE_URL se saltan en vez de fallar, así la suite corre también en
 * una máquina sin Postgres.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);
const TZ = 'America/Argentina/Buenos_Aires';

// La diferencia de días se mide al mediodía UTC: la hora de 0 h local puede
// no existir o repetirse con el horario de verano, al mediodía no hay hueco.
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

describe.skipIf(!dbAvailable)('resolveRange', () => {
  it("'all' arranca en 2000-01-01 (centinela del plan §7) y termina hoy", async () => {
    const { from, to } = await resolveRange('all', TZ);
    expect(from).toBe('2000-01-01');
    expect(to).toBe(await today(TZ));
  });

  it("'today' es un rango de un solo día que termina hoy", async () => {
    const { from, to } = await resolveRange('today', TZ);
    expect(from).toBe(to);
    expect(to).toBe(await today(TZ));
  });

  it("'yesterday' es un solo día, distinto de hoy", async () => {
    const { from, to } = await resolveRange('yesterday', TZ);
    expect(from).toBe(to);
    expect(to).not.toBe(await today(TZ));
  });

  it.each([
    ['7d', 6],
    ['14d', 13],
    ['30d', 29],
  ] as const)("'%s' cubre %i días corridos hasta hoy", async (preset, days) => {
    const { from, to } = await resolveRange(preset, TZ);
    expect(daysBetween(from, to)).toBe(days);
    expect(to).toBe(await today(TZ));
  });

  it("'mtd' arranca el día 1 del mes en curso", async () => {
    const { from, to } = await resolveRange('mtd', TZ);
    expect(from.endsWith('-01')).toBe(true);
    expect(from <= to).toBe(true);
    expect(to).toBe(await today(TZ));
  });

  it('todos los presets devuelven un rango válido (from <= to)', async () => {
    const presets: RangePreset[] = ['today', 'yesterday', '7d', '14d', '30d', 'mtd', 'all'];
    for (const p of presets) {
      const { from, to } = await resolveRange(p, TZ);
      expect(from <= to, `${p}: ${from} > ${to}`).toBe(true);
    }
  });
});
