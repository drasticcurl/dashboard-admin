import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  frasesFrescura,
  frescuraDeFila,
  resumenFrescura,
  textoAntiguedad,
  textoDuracion,
  type FrescuraFila,
} from './celdas';

/**
 * Task 8 de frescura-y-acciones-anuncios: la clasificación de la Marca_Frescura
 * de una fila (R3.1, R3.3).
 *
 * El caso que este test viene a cubrir es de producción: 34 de 326 conjuntos, 13
 * de 216 campañas y 38 de 505 anuncios no se refrescaban desde hacía más de 20
 * minutos, el más viejo desde hacía 5 días y 17 horas, y la tabla los dibujaba
 * como si fueran actuales.
 *
 * Los bordes que se fijan acá son los cuatro que la clasificación puede errar en
 * silencio: la fila de gasto sin objeto local (`syncedAt` nulo), la desaparición
 * con un `syncedAt` fresco, el umbral exacto y el reloj del navegador adelantado
 * respecto del que escribió las fechas.
 */

const UMBRAL = 900; // el que seedea la migración 025

const AHORA = Date.parse('2025-08-21T12:00:00.000Z');

/** Una fila cuyo dato se confirmó hace `segundos`. */
function haceSegundos(segundos: number): string {
  return new Date(AHORA - segundos * 1000).toISOString();
}

function fila(
  syncedAt: string | null,
  desaparecidoAt: string | null = null,
): { syncedAt: string | null; desaparecidoAt: string | null } {
  return { syncedAt, desaparecidoAt };
}

describe('frescuraDeFila', () => {
  it('una fila de gasto sin objeto en la Jerarquía no está vieja: no tiene dato que envejecer', () => {
    // `syncedAt === null` son las filas que salen del UNION ALL con `gasto`:
    // hubo gasto atribuido a un objeto que no tiene fila local. Marcarlas como
    // desactualizadas sería inventarles un problema, y es el error más fácil de
    // cometer si se compara `null` contra el umbral.
    expect(frescuraDeFila(fila(null), UMBRAL, AHORA)).toEqual<FrescuraFila>({
      marca: 'sin_jerarquia',
    });
    // Con cualquier umbral, incluso 0.
    expect(frescuraDeFila(fila(null), 0, AHORA).marca).toBe('sin_jerarquia');
  });

  it('dentro del umbral está al día', () => {
    expect(frescuraDeFila(fila(haceSegundos(60)), UMBRAL, AHORA)).toEqual<FrescuraFila>({
      marca: 'al_dia',
      edadSegundos: 60,
    });
  });

  it('el umbral exacto todavía está al día: "supera" es estricto', () => {
    // Los 900 segundos justos son el instante en el que la corrida del cron
    // (cada 15 min) llega a confirmar la fila. Marcar ahí sería marcar el caso
    // normal.
    expect(frescuraDeFila(fila(haceSegundos(UMBRAL)), UMBRAL, AHORA).marca).toBe('al_dia');
    expect(frescuraDeFila(fila(haceSegundos(UMBRAL + 1)), UMBRAL, AHORA)).toEqual<FrescuraFila>({
      marca: 'vieja',
      edadSegundos: UMBRAL + 1,
    });
  });

  it('el objeto más viejo de producción queda marcado y con su antigüedad', () => {
    const cincoDiasDiecisieteHoras = 5 * 86_400 + 17 * 3600;
    const f = frescuraDeFila(fila(haceSegundos(cincoDiasDiecisieteHoras)), UMBRAL, AHORA);
    expect(f.marca).toBe('vieja');
    expect(f).toHaveProperty('edadSegundos', cincoDiasDiecisieteHoras);
    if (f.marca !== 'vieja') throw new Error('inalcanzable');
    expect(textoAntiguedad(f.edadSegundos)).toBe('hace 5 d 17 h');
  });

  it('la desaparición gana sobre la vejez, incluso con un syncedAt fresco', () => {
    // Puede pasar y no es raro: la corrida que detecta que Meta ya no devuelve
    // el objeto es la misma que acaba de confirmar el resto de la cuenta, así que
    // el objeto puede tener un `synced_at` de hace un minuto y estar
    // desaparecido. La condición grave no puede quedar tapada por la otra.
    const f = frescuraDeFila(fila(haceSegundos(30), haceSegundos(10)), UMBRAL, AHORA);
    expect(f).toEqual<FrescuraFila>({ marca: 'desaparecida', edadSegundos: 30, desdeSegundos: 10 });
  });

  it('una fila desaparecida y vieja se marca como desaparecida, no como vieja', () => {
    const f = frescuraDeFila(fila(haceSegundos(5 * 86_400), haceSegundos(2 * 86_400)), UMBRAL, AHORA);
    expect(f.marca).toBe('desaparecida');
  });

  it('un desaparecidoAt sin syncedAt marca igual, con la antigüedad en null', () => {
    expect(frescuraDeFila(fila(null, haceSegundos(120)), UMBRAL, AHORA)).toEqual<FrescuraFila>({
      marca: 'desaparecida',
      edadSegundos: null,
      desdeSegundos: 120,
    });
  });

  it('un syncedAt en el futuro es un dato de recién, no una antigüedad negativa', () => {
    // El reloj del navegador contra fechas escritas por el reloj del server: con
    // la máquina del usuario adelantada, un objeto recién sincronizado da una
    // diferencia negativa. Se acota en 0, y por lo tanto NUNCA produce una marca:
    // marcar de más sería un aviso falso sobre plata.
    const f = frescuraDeFila(fila(new Date(AHORA + 3600 * 1000).toISOString()), UMBRAL, AHORA);
    expect(f).toEqual<FrescuraFila>({ marca: 'al_dia', edadSegundos: 0 });
  });

  it('una fecha ilegible o vacía en syncedAt no inventa una marca de vieja', () => {
    for (const basura of ['', '   ', 'no soy una fecha']) {
      expect(frescuraDeFila(fila(basura), UMBRAL, AHORA).marca).toBe('sin_jerarquia');
    }
  });

  it('un desaparecidoAt ilegible sigue marcando la fila, sin antigüedad', () => {
    // Al revés que arriba a propósito: un badge sin el "hace cuánto" avisa; no
    // marcar esconde el objeto que Meta dejó de devolver, que es lo grave.
    const f = frescuraDeFila(fila(haceSegundos(60), 'no soy una fecha'), UMBRAL, AHORA);
    expect(f).toEqual<FrescuraFila>({ marca: 'desaparecida', edadSegundos: 60, desdeSegundos: null });
    // `''` sí cuenta como ausencia de fecha, no como desaparición.
    expect(frescuraDeFila(fila(haceSegundos(60), ''), UMBRAL, AHORA).marca).toBe('al_dia');
  });

  it('un umbral corrupto no marca las 505 filas', () => {
    // Si la fila de `settings` viene con algo que no es número, el desenlace
    // correcto es no marcar nada, no marcar todo.
    for (const umbral of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(frescuraDeFila(fila(haceSegundos(10 * 86_400)), umbral, AHORA).marca).toBe('al_dia');
    }
  });

  // Totalidad de la clasificación. No es ninguna de las Correctness Properties
  // numeradas del design: son los tres invariantes que la función no puede
  // romper para NINGÚN par de fechas y ningún umbral.
  it('para toda fila y todo umbral: nunca antigüedad negativa, nunca vieja sin dato, desaparecida ⟺ desaparecidoAt', () => {
    const genFecha = fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc.constant('no soy una fecha'),
      // `noInvalidDate` porque en fast-check 4 `fc.date` genera `Invalid Date`
      // por defecto, y ahí `toISOString()` tira antes de correr la propiedad. El
      // caso de la fecha ilegible ya lo cubren los dos `constant` de arriba.
      fc
        .date({
          min: new Date(AHORA - 400 * 86_400_000),
          max: new Date(AHORA + 86_400_000),
          noInvalidDate: true,
        })
        .map((d) => d.toISOString()),
    );
    fc.assert(
      fc.property(genFecha, genFecha, fc.integer({ min: 0, max: 86_400 }), (s, d, umbral) => {
        const f = frescuraDeFila({ syncedAt: s, desaparecidoAt: d }, umbral, AHORA);

        const hayDesaparicion = d !== null && d.trim() !== '';
        expect(f.marca === 'desaparecida').toBe(hayDesaparicion);

        if (f.marca === 'vieja' || f.marca === 'al_dia') {
          expect(f.edadSegundos).toBeGreaterThanOrEqual(0);
          // La marca sale de la comparación con el umbral y de nada más.
          expect(f.marca === 'vieja').toBe(f.edadSegundos > umbral);
        }
        if (f.marca === 'desaparecida') {
          if (f.edadSegundos !== null) expect(f.edadSegundos).toBeGreaterThanOrEqual(0);
          if (f.desdeSegundos !== null) expect(f.desdeSegundos).toBeGreaterThanOrEqual(0);
        }
        // Sin fecha legible no hay forma de afirmar que el dato está viejo.
        if (f.marca === 'vieja') expect(Number.isNaN(Date.parse(String(s)))).toBe(false);
      }),
    );
  });

  it('subir el umbral nunca agrega marcas', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 * 86_400 }),
        fc.integer({ min: 0, max: 86_400 }),
        fc.integer({ min: 0, max: 86_400 }),
        (edad, u1, u2) => {
          const bajo = Math.min(u1, u2);
          const alto = Math.max(u1, u2);
          const f = fila(haceSegundos(edad));
          const conAlto = frescuraDeFila(f, alto, AHORA);
          if (conAlto.marca === 'vieja') {
            expect(frescuraDeFila(f, bajo, AHORA).marca).toBe('vieja');
          }
        },
      ),
    );
  });
});

describe('textoDuracion', () => {
  it('cuenta en la unidad que conserva la información', () => {
    expect(textoDuracion(0)).toBe('menos de 1 min');
    expect(textoDuracion(59)).toBe('menos de 1 min');
    expect(textoDuracion(60)).toBe('1 min');
    expect(textoDuracion(900)).toBe('15 min');
    expect(textoDuracion(3599)).toBe('59 min');
    expect(textoDuracion(3600)).toBe('1 h');
    expect(textoDuracion(86_399)).toBe('23 h');
    expect(textoDuracion(86_400)).toBe('1 d');
    // Los días llevan las horas al lado: la diferencia entre "5 d" y "5 d 17 h"
    // es la que hace evidente que el objeto está abandonado y no atrasado.
    expect(textoDuracion(5 * 86_400 + 17 * 3600)).toBe('5 d 17 h');
    expect(textoDuracion(5 * 86_400)).toBe('5 d');
    expect(textoDuracion(5 * 86_400 + 59 * 60)).toBe('5 d');
  });

  it('redondea para abajo: el número se lee como "por lo menos tan viejo"', () => {
    // Con Math.round, el objeto de 5 d 17 h de producción se leería "hace 6 d",
    // que es una antigüedad que ese dato no tiene.
    expect(textoDuracion(119)).toBe('1 min');
    expect(textoDuracion(7100)).toBe('1 h');
  });

  it('es total: ni negativos ni NaN producen texto roto', () => {
    expect(textoDuracion(-5)).toBe('menos de 1 min');
    expect(textoDuracion(Number.NaN)).toBe('menos de 1 min');
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 400 * 86_400 }), (s) => {
        const t = textoDuracion(s);
        expect(t.length).toBeGreaterThan(0);
        expect(t).not.toContain('NaN');
        expect(t).not.toContain('-');
      }),
    );
  });
});

describe('resumenFrescura', () => {
  it('cuenta las dos condiciones por separado y no mezcla las filas sin jerarquía', () => {
    const filas = [
      fila(haceSegundos(30)), // al día
      fila(haceSegundos(60)), // al día
      fila(haceSegundos(1200)), // vieja
      fila(haceSegundos(5 * 86_400 + 17 * 3600)), // vieja, la más vieja
      fila(haceSegundos(3600), haceSegundos(600)), // desaparecida
      fila(null), // gasto sin objeto local
    ];
    expect(resumenFrescura(filas, UMBRAL, AHORA)).toEqual({
      viejas: 2,
      desaparecidas: 1,
      sinJerarquia: 1,
      masViejaSegundos: 5 * 86_400 + 17 * 3600,
    });
  });

  it('sin nada marcado no hay antigüedad máxima, y el Banner no se dibuja', () => {
    const r = resumenFrescura([fila(haceSegundos(10)), fila(null)], UMBRAL, AHORA);
    expect(r.viejas).toBe(0);
    expect(r.desaparecidas).toBe(0);
    expect(r.masViejaSegundos).toBeNull();
  });

  it('la antigüedad máxima también sale de una fila desaparecida', () => {
    const r = resumenFrescura(
      [fila(haceSegundos(1000)), fila(haceSegundos(9 * 86_400), haceSegundos(86_400))],
      UMBRAL,
      AHORA,
    );
    expect(r.masViejaSegundos).toBe(9 * 86_400);
  });

  it('los conteos nunca exceden la cantidad de filas', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            syncedAt: fc.oneof(
              fc.constant(null),
              fc.integer({ min: 0, max: 40 * 86_400 }).map(haceSegundos),
            ),
            desaparecidoAt: fc.oneof(
              fc.constant(null),
              fc.integer({ min: 0, max: 40 * 86_400 }).map(haceSegundos),
            ),
          }),
          { maxLength: 40 },
        ),
        (filas) => {
          const r = resumenFrescura(filas, UMBRAL, AHORA);
          expect(r.viejas + r.desaparecidas + r.sinJerarquia).toBeLessThanOrEqual(filas.length);
          if (r.viejas + r.desaparecidas === 0) expect(r.masViejaSegundos).toBeNull();
        },
      ),
    );
  });
});

describe('frasesFrescura', () => {
  it('sin marcas no dice nada: el Banner no se dibuja', () => {
    expect(
      frasesFrescura({ viejas: 0, desaparecidas: 0, sinJerarquia: 7, masViejaSegundos: null }, 7, UMBRAL),
    ).toEqual([]);
  });

  it('el caso de producción: dice el conteo, sobre qué está contado y el umbral', () => {
    // 38 de 505 anuncios sin refrescar, el más viejo desde hacía 5 d 17 h.
    const frases = frasesFrescura(
      { viejas: 38, desaparecidas: 0, sinJerarquia: 0, masViejaSegundos: 5 * 86_400 + 17 * 3600 },
      505,
      UMBRAL,
    );
    const texto = frases.join(' ');
    expect(texto).toContain('38');
    // Sobre qué está contado: las filas en pantalla, no el filtro completo.
    expect(texto).toContain('505 filas en pantalla');
    expect(texto).toContain('15 min');
    expect(texto).toContain('hace 5 d 17 h');
  });

  it('las dos condiciones dicen cosas distintas: una se arregla sola, la otra no', () => {
    const soloViejas = frasesFrescura(
      { viejas: 3, desaparecidas: 0, sinJerarquia: 0, masViejaSegundos: 3600 },
      100,
      UMBRAL,
    ).join(' ');
    const conDesaparecidas = frasesFrescura(
      { viejas: 0, desaparecidas: 2, sinJerarquia: 0, masViejaSegundos: 86_400 },
      100,
      UMBRAL,
    ).join(' ');

    expect(soloViejas).toContain('las vuelve a confirmar');
    expect(soloViejas).not.toContain('no se pone al día solo');
    expect(conDesaparecidas).toContain('no se pone al día solo');
    expect(conDesaparecidas).toContain('Meta dejó de devolver');
  });

  it('una sola fila vieja no queda en plural', () => {
    const frase = frasesFrescura(
      { viejas: 1, desaparecidas: 0, sinJerarquia: 0, masViejaSegundos: 1000 },
      50,
      UMBRAL,
    )[0];
    expect(frase).toContain('1 de las 50 filas en pantalla no se confirma contra Meta');
  });
});
