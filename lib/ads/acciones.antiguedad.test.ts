import { describe, expect, it } from 'vitest';
import {
  decidioConMeta,
  edadDelDatoDeOmision,
  textoAntiguedad,
  type ObjetoPreflight,
  type RelecturaPreflight,
  type ResultadoRelectura,
} from './acciones';

/**
 * La antigüedad en el mensaje de Omisión (task 14.3 de
 * frescura-y-acciones-anuncios, R6.1).
 *
 * QUÉ DEFIENDE ESTE ARCHIVO. R6.1 pide que cuando el Preflight omite un objeto
 * «porque su copia local ya está en el estado pedido», el mensaje nombre esa
 * razón Y la antigüedad del dato con el que se decidió. La razón ya la daba el
 * catálogo de `mensajes.ts`; lo que falta es el segundo dato, que es el que
 * convierte «el botón no hizo nada» en «el panel decidió con una foto de hace
 * cinco días». Sin él el aviso es literalmente el mismo texto para una omisión
 * correcta sobre un dato de un minuto y para una omisión tomada sobre una fila
 * que Meta dejó de confirmar hace una semana.
 *
 * Todo acá es puro: `edadDelDatoDeOmision` no lee la base ni la red, así que no
 * hay nada que mockear ni que saltear sin `DATABASE_URL`. El viaje completo
 * —preflight real a nivel anuncio que produce el valor— está en
 * `acciones.nivelAnuncio.test.ts`, y el consumo del lado del cliente en
 * `mensajes.test.ts`.
 *
 * SIN PROPIEDAD DE FAST-CHECK a propósito: el design no numera ninguna para R6.1,
 * y el espacio de entradas relevante es finito y chico —los cinco valores de
 * `ResultadoRelectura` por «hubo relectura o no»—, así que se recorre completo
 * en lugar de muestrearlo. El `for` sobre `RESULTADOS` es esa enumeración: si
 * alguien suma un sexto desenlace, el caso queda cubierto sin tocar el test.
 */

const AHORA = new Date('2025-03-10T12:00:00.000Z');

/** Los cinco desenlaces de la relectura, para recorrerlos completos. */
const RESULTADOS: readonly ResultadoRelectura[] = [
  'coincide',
  'discrepa',
  'no_encontrado',
  'error',
  'no_intentada',
];

/** Un objeto de la Jerarquía con lo mínimo que esta función lee. */
function obj(syncedAt: string | null): ObjetoPreflight {
  return {
    objectId: '120210000000000001',
    objectName: 'Conjunto frío EUR',
    accountId: 'act_1',
    status: 'PAUSED',
    effectiveStatus: 'PAUSED',
    campaignId: '120210000000000000',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudget: 2500,
    currency: 'EUR',
    inicioProgramado: null,
    syncedAt,
    desaparecidoAt: null,
    statusCampania: 'ACTIVE',
    statusConjunto: null,
  };
}

function rel(over: Partial<RelecturaPreflight> = {}): RelecturaPreflight {
  return {
    objectId: '120210000000000001',
    causa: 'vieja',
    syncedAt: '2025-03-05T12:00:00.000Z',
    edadSegundos: 5 * 86_400,
    local: 'PAUSED',
    real: null,
    localEffective: 'PAUSED',
    realEffective: null,
    resultado: 'no_intentada',
    detalle: null,
    ...over,
  };
}

// ─── Camino 3: no hubo relectura (el caso más común) ─────────────────────────

describe('sin relectura, la edad sale del synced_at de la fila (R6.1)', () => {
  it('un dato de hace cuatro minutos se nombra en minutos', () => {
    const o = obj(new Date(AHORA.getTime() - 4 * 60_000).toISOString());

    expect(edadDelDatoDeOmision(o, undefined, AHORA)).toBe('de hace 4 min');
  });

  it('la escala es la misma que la de la auditoría, sin un redondeo propio', () => {
    // El mismo `textoAntiguedad` que arma la `explicacion` de `ad_actions`: un
    // objeto no puede quedar con «hace 5 d» en el historial y otra cifra en
    // pantalla, porque entonces se duda de las dos.
    for (const segundos of [30, 240, 7_200, 5 * 86_400]) {
      const o = obj(new Date(AHORA.getTime() - segundos * 1000).toISOString());
      expect(edadDelDatoDeOmision(o, undefined, AHORA)).toBe(textoAntiguedad(segundos));
    }
  });

  it('un synced_at nulo NO se lee como «recién»', () => {
    // La resta contra un null daría cero, y el mensaje presentaría el peor dato
    // posible (no se sabe cuándo se vio este objeto) como el mejor.
    const t = edadDelDatoDeOmision(obj(null), undefined, AHORA);

    expect(t).toBe('sin fecha de sincronización');
    expect(t).not.toContain('menos de un minuto');
  });

  it('un synced_at ilegible tampoco', () => {
    expect(edadDelDatoDeOmision(obj('no es una fecha'), undefined, AHORA)).toBe(
      'sin fecha de sincronización',
    );
  });
});

// ─── Camino 1: la decisión se tomó contra Meta ───────────────────────────────

describe('con una relectura que se pudo usar, la edad local ya no es la que decidió', () => {
  it('cuando Meta confirmó el estado, no se cita la antigüedad de la base', () => {
    // El objeto tiene un dato de 5 días, pero la Omisión NO se decidió con él:
    // se decidió con una lectura del momento del pedido. Citar los 5 días acá
    // haría dudar de una decisión que está bien tomada.
    const t = edadDelDatoDeOmision(obj('2025-03-05T12:00:00.000Z'), rel({ resultado: 'coincide', real: 'PAUSED' }), AHORA);

    expect(t).toBe('confirmado contra Meta al resolver el pedido');
    expect(t).not.toContain('5 d');
  });

  it('lo mismo cuando Meta desmintió a la base y el estado real decidió igual', () => {
    // `discrepa` también puede terminar en Omisión: la base decía PAUSED, Meta
    // dice ACTIVE y la acción pedida era activar.
    const t = edadDelDatoDeOmision(
      obj('2025-03-05T12:00:00.000Z'),
      rel({ resultado: 'discrepa', real: 'ACTIVE', realEffective: 'ACTIVE' }),
      AHORA,
    );

    expect(t).toBe('confirmado contra Meta al resolver el pedido');
  });
});

// ─── Camino 2: hubo relectura y no se pudo usar ──────────────────────────────

describe('con una relectura que falló, se cita la edad y se dice que no se revalidó', () => {
  it('los tres desenlaces sin dato de Meta nombran la antigüedad y la duda', () => {
    for (const resultado of ['error', 'no_encontrado', 'no_intentada'] as const) {
      const t = edadDelDatoDeOmision(obj(null), rel({ resultado }), AHORA);

      expect(t, resultado).toContain('de hace 5 d');
      expect(t, resultado).toContain('no se pudo revalidar');
    }
  });

  it('la edad es la del instante de la decisión, no la de ahora', () => {
    // `edadSegundos` lo calculó el preflight con su propio `ahora`. Recalcularlo
    // acá sumaría el tiempo que tardó el lote y diría una edad que no es la que
    // decidió: el `syncedAt` del objeto puede además ser otro, porque
    // `refrescarJerarquia` lo reescribe cuando una escritura se confirma.
    const t = edadDelDatoDeOmision(
      obj(new Date(AHORA.getTime() - 60_000).toISOString()),
      rel({ resultado: 'error', edadSegundos: 3 * 86_400 }),
      AHORA,
    );

    expect(t).toContain('de hace 3 d');
    expect(t).not.toContain('min');
  });

  it('sin fecha de sincronización se dice así, y con la duda igual', () => {
    const t = edadDelDatoDeOmision(obj(null), rel({ resultado: 'error', edadSegundos: null }), AHORA);

    expect(t).toBe('sin fecha de sincronización, que no se pudo revalidar contra Meta');
  });
});

// ─── Las dos invariantes que hacen que el texto se pueda componer ────────────

describe('el valor compone la frase del cliente y no la contradice', () => {
  it('los cinco desenlaces dicen «se decidió con Meta» si y sólo si decidioConMeta', () => {
    // Es LA coherencia que importa: si el mensaje al usuario dice «según un dato
    // de hace 5 días» sobre una decisión que se tomó contra Meta —o al revés—,
    // el aviso vuelve a mentir, que es lo que este spec vino a sacar de la
    // pantalla. `metricsDeRelectura` y `explicacionDeRelectura` (task 14.2) se
    // apoyan en la misma función, así que la auditoría y la pantalla no pueden
    // discrepar tampoco.
    for (const resultado of RESULTADOS) {
      const r = rel({ resultado, real: resultado === 'no_intentada' ? null : 'PAUSED' });
      const t = edadDelDatoDeOmision(obj('2025-03-05T12:00:00.000Z'), r, AHORA);

      expect(t.includes('confirmado contra Meta'), resultado).toBe(decidioConMeta(r));
    }
  });

  it('todo valor es una cola de frase: minúscula, sin punto y no vacía', () => {
    // El cliente cierra con `según un dato ${edadDelDato}.` (regla 2 de
    // `mensajes.ts`), así que un valor con mayúscula inicial o con punto propio
    // rompería la oración. Se verifica sobre los tres caminos completos.
    const valores = [
      edadDelDatoDeOmision(obj(new Date(AHORA.getTime() - 60_000).toISOString()), undefined, AHORA),
      edadDelDatoDeOmision(obj(null), undefined, AHORA),
      ...RESULTADOS.map((resultado) =>
        edadDelDatoDeOmision(obj('2025-03-05T12:00:00.000Z'), rel({ resultado }), AHORA),
      ),
    ];

    for (const v of valores) {
      expect(v.length, v).toBeGreaterThan(0);
      expect(v[0], v).toBe(v[0]!.toLowerCase());
      expect(v.endsWith('.'), v).toBe(false);
      expect(`según un dato ${v}.`, v).toMatch(/^según un dato \S.*[^.]\.$/);
    }
  });
});
