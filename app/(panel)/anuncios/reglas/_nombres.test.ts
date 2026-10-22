import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fraseFiltroNombre, nombreDeCopia } from './_nombres';
import { agruparReglas, aplicadoA, problema } from './ReglasView';
import type { ReglaFila } from './_tipos';
import { formBase } from './_formBase';

/**
 * Property 10 y los dos casos puros de la pantalla (task 9.5 y 9.6).
 *
 * `problema` y `aplicadoA` viven en ReglasView.tsx (componente cliente) y se
 * importan desde acá; si el environment 'node' de Vitest no puede cargar el
 * componente (recharts, etc.), el plan B del task es moverlas a _nombres.ts.
 */

describe('nombreDeCopia', () => {
  it('Feature: reglas-anuncios-por-cuenta, Property 10: el nombre que propone Duplicar nunca colisiona dentro de la cuenta', () => {
    fc.assert(
      fc.property(
        genNombre().chain((base) =>
          // Algunos ocupados son exactamente los primeros candidatos de la
          // copia, para forzar el bucle de sufijos.
          fc
            .array(
              fc.oneof(
                fc.constant(`${base} (copia)`),
                fc.constant(`${base} (copia 2)`),
                fc.constant(`${base} (copia 3)`),
                fc.string({ minLength: 1, maxLength: 200 }),
              ),
              { minLength: 0, maxLength: 50 },
            )
            .map((ocupados) => ({ base, ocupados })),
        ),
        ({ base, ocupados }) => {
          const propuesto = nombreDeCopia(base, ocupados);
          // El único es (account_id, name): la colisión se mide contra los
          // nombres de ESA cuenta y de ninguna otra.
          expect(ocupados).not.toContain(propuesto);
          // Nunca vacío después de trim, y dentro del tope de 200 de
          // ad_rules.name (el mismo que el zod).
          expect(propuesto.trim().length).toBeGreaterThan(0);
          expect(propuesto.length).toBeLessThanOrEqual(200);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Generador del nombre base: 1..200 caracteres, incluidos los que ya terminan
  // en un sufijo de copia, que es el caso que se verifica aparte.
  function genNombre(): fc.Arbitrary<string> {
    return fc.oneof(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc
        .tuple(fc.string({ minLength: 1, maxLength: 180 }), fc.integer({ min: 1, max: 99 }))
        .map(([base, n]) => `${base} (copia ${n})`),
    );
  }
});

describe('problema y aplicadoA (task 9.6)', () => {
  it('problema sin ninguna cuenta tildada devuelve el mensaje que nombra el campo (R8 c4)', () => {
    expect(problema(formBase({ accountIds: [] }))).toBe('Falta la cuenta de anuncios.');
    // Con una o varias cuentas elegidas, el mensaje de cuenta no aparece.
    expect(problema(formBase({ accountIds: ['act_123'] }))).toBeNull();
    expect(problema(formBase({ accountIds: ['act_123', 'act_456'] }))).toBeNull();
  });

  it('el nombre repetido se ataja en CUALQUIERA de las cuentas elegidas (037)', () => {
    const otras = [{ accountId: 'act_456', name: 'Apagar' }];
    expect(problema(formBase({ name: 'Apagar', accountIds: ['act_123'] }), otras)).toBeNull();
    expect(problema(formBase({ name: 'Apagar', accountIds: ['act_123', 'act_456'] }), otras)).toContain('único por cuenta');
  });

  // La ventana horaria tenía dos formas de guardarse mal, y las dos terminaban
  // en una regla que no corre: media ventana (400 del API, después de llenar
  // todo el formulario) y las dos horas iguales, que nadie atajaba y deja a la
  // regla con 60 segundos por día para correr.
  it('problema ataja la media ventana horaria y las dos horas iguales', () => {
    expect(problema(formBase({ windowStart: '08:00', windowEnd: '' }))).toContain('completa o vacía');
    expect(problema(formBase({ windowStart: '', windowEnd: '23:00' }))).toContain('completa o vacía');
    expect(problema(formBase({ windowStart: '12:30', windowEnd: '12:30' }))).toContain('ese minuto exacto');
    // Una ventana normal y una que cruza la medianoche (dentroDeVentana la
    // soporta con start > end) son válidas.
    expect(problema(formBase({ windowStart: '08:00', windowEnd: '23:00' }))).toBeNull();
    expect(problema(formBase({ windowStart: '22:00', windowEnd: '06:00' }))).toBeNull();
  });

  it('aplicadoA nombra la cuenta concreta y su zona, nunca "N cuentas" ni "todas las cuentas" (R8 c6)', () => {
    const cuentas = [
      { accountId: 'act_a', name: 'HIlvanapp', timezone: 'Europe/Lisbon' },
      { accountId: 'act_b', name: 'Protocolo reset', timezone: 'America/Argentina/Buenos_Aires' },
    ];
    const texto = aplicadoA({ accountIds: ['act_b'], level: 'adset', statusFilter: 'active' }, cuentas);
    expect(texto).toContain('Protocolo reset');
    expect(texto).toContain('America/Argentina/Buenos_Aires');
    expect(texto).not.toContain('cuentas');
    expect(texto).not.toContain('todas');
    // Una regla general nombra CADA cuenta, no una cantidad.
    const dos = aplicadoA({ accountIds: ['act_a', 'act_b'], level: 'adset', statusFilter: 'active' }, cuentas);
    expect(dos).toContain('HIlvanapp');
    expect(dos).toContain('Protocolo reset');
    expect(dos).not.toMatch(/\d+ cuentas/);
  });

  it('aplicadoA muestra el filtro por nombre, así «sin CBO» se ve en la lista', () => {
    const cuentas = [{ accountId: 'act_a', name: 'HIlvanapp', timezone: 'Europe/Lisbon' }];
    const base = { accountIds: ['act_a'], level: 'adset' as const, statusFilter: 'active' as const };
    expect(aplicadoA({ ...base, nameFilter: 'CBO', nameFilterMode: 'not_contains' }, cuentas)).toBe(
      'Conjuntos activos sin «CBO» · HIlvanapp · Europe/Lisbon',
    );
    expect(aplicadoA({ ...base, nameFilter: 'PXN', nameFilterMode: 'contains' }, cuentas)).toBe(
      'Conjuntos activos con «PXN» · HIlvanapp · Europe/Lisbon',
    );
    expect(aplicadoA({ ...base, nameFilter: null, nameFilterMode: 'not_contains' }, cuentas)).toBe(
      'Conjuntos activos · HIlvanapp · Europe/Lisbon',
    );
  });
});

describe('fraseFiltroNombre', () => {
  it('nombra a los padres que el motor también mira', () => {
    expect(fraseFiltroNombre('adset', 'not_contains', 'CBO')).toBe('sin «CBO» en su nombre ni en el de su campaña');
    expect(fraseFiltroNombre('adset', 'contains', 'PXN')).toBe('con «PXN» en su nombre o en el de su campaña');
    expect(fraseFiltroNombre('ad', 'not_contains', 'CBO')).toBe(
      'sin «CBO» en su nombre, ni en el de su conjunto ni en el de su campaña',
    );
    expect(fraseFiltroNombre('campaign', 'not_contains', 'CBO')).toBe('sin «CBO» en el nombre');
  });

  it('sin texto no hay frase, y el texto va sin los espacios de los bordes', () => {
    expect(fraseFiltroNombre('adset', 'not_contains', '   ')).toBe('');
    expect(fraseFiltroNombre('adset', 'contains', null)).toBe('');
    expect(fraseFiltroNombre('campaign', 'contains', ' PXN ')).toBe('con «PXN» en el nombre');
  });
});

describe('agruparReglas (037)', () => {
  const fila = (over: Partial<ReglaFila>): ReglaFila =>
    ({
      id: 1, grupo: 'g1', name: 'R', enabled: false, dryRun: false, accountId: 'act_a',
      level: 'adset', statusFilter: 'active', nameFilter: null, nameFilterMode: 'contains',
      action: 'pause', actionValue: null, actionUnit: null, budgetMax: null, budgetMin: null,
      period: 'today', metricsLevel: 'object', everyMinutes: 15, windowStart: null, windowEnd: null,
      maxRunsPerDay: null, cooldownMinutes: 60, maxActionsPerObjectPerDay: 4, condiciones: [],
      lastRunAt: null, lastRunError: null, createdAt: '', updatedAt: '',
      ...over,
    }) as ReglaFila;
  const cuentas = [
    { accountId: 'act_a', name: 'HIlvanapp', timezone: 'Europe/Lisbon' },
    { accountId: 'act_b', name: 'Gelxiin', timezone: 'Europe/Lisbon' },
  ];

  it('junta las filas del mismo grupo en una regla con todas sus cuentas, en el orden de las cuentas', () => {
    const g = agruparReglas(
      [
        fila({ id: 7, accountId: 'act_b', lastRunAt: '2026-09-30T10:00:00Z' }),
        fila({ id: 3, accountId: 'act_a', enabled: true, lastRunAt: '2026-09-30T09:00:00Z' }),
        fila({ id: 9, grupo: 'g2', name: 'Otra', accountId: 'act_b' }),
      ],
      cuentas,
    );
    expect(g).toHaveLength(2);
    const r = g.find((x) => x.grupo === 'g1')!;
    expect(r.accountIds).toEqual(['act_a', 'act_b']);
    expect(r.id).toBe(3);
    expect(r.enabled).toBe(true);
    expect(r.lastRunAt).toBe('2026-09-30T10:00:00Z');
    expect(g.find((x) => x.grupo === 'g2')!.accountIds).toEqual(['act_b']);
  });
});
