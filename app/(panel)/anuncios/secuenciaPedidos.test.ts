import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { conservarPintadoEnVuelo, crearSecuencia, filasConEstado } from './GestorAnuncios';

/**
 * Tests del descarte de respuestas de datos fuera de orden (task 12 de
 * frescura-y-acciones-anuncios, R5 c4).
 *
 * El bug que este archivo existe para que no vuelva: tres fuentes piden filas
 * sin coordinarse —el efecto de filtros, el Boton_Actualizar y el refetch
 * posterior a un lote— y la última respuesta en llegar pintaba, aunque fuera la
 * más vieja. Es uno de los mecanismos detrás del "el gasto baja de la nada": el
 * Boton_Actualizar con `forzar` espera dos sincronizaciones antes de leer, así
 * que puede tardar 60 s y volver DESPUÉS de un pedido de filtros emitido más
 * tarde, pisando números frescos con una lectura anterior.
 *
 * El `AbortController` que cada pedido ya tenía no cubría esto: aborta por
 * timeout, no cancela el pedido anterior cuando sale uno nuevo.
 *
 * ## Sin render
 *
 * `vitest.config.ts` corre en node por decisión de todo el repo: sin jsdom, sin
 * testing-library. La decisión "¿esta respuesta se pinta?" se extrajo a
 * `crearSecuencia` y la convivencia con el Pintado_Optimista a
 * `conservarPintadoEnVuelo`, las dos exportadas desde el componente, para que se
 * puedan ejercitar sin montar nada.
 *
 * `pantalla()` de abajo es el mismo par de líneas que el `aplicarRespuesta` del
 * componente: la guarda y el merge son código de producción, lo único del test
 * es la variable donde queda el cuerpo.
 *
 * ## Lo que queda sin cubrir
 *
 * El cableado de los cuatro llamadores (que cada uno pase el `seq` que le
 * devolvió `pedirFilas` y no otro). Lo sostiene la forma del retorno: el número y
 * la promesa salen juntos del único punto de emisión, así que no hay forma de
 * pedir filas sin número ni de aplicar un cuerpo con el número de otro pedido.
 */

// ─── Modelo de pantalla ──────────────────────────────────────────────────────

type Fila = { objectId: string; status: string | null; spendEur: number };

/** Un cuerpo del endpoint de datos, reducido a las filas y una marca para saber cuál es. */
type Cuerpo = { marca: number; filas: Fila[] };

function cuerpo(marca: number, filas: Fila[] = []): Cuerpo {
  return { marca, filas };
}

/**
 * La pantalla reducida a lo que este descarte toca: un cuerpo visible, el
 * contador de pedidos y los ids con un cambio de estado en vuelo.
 */
function pantalla(inicial: Cuerpo) {
  const secuencia = crearSecuencia();
  const enVuelo = new Set<string>();
  let visible = inicial;

  return {
    secuencia,
    enVuelo,
    get visible(): Cuerpo {
      return visible;
    },
    /** El `aplicarRespuesta` del componente: la guarda decide y el merge pinta. */
    aplicar(seq: number, body: Cuerpo): boolean {
      if (!secuencia.aplicar(seq)) return false;
      visible = { ...body, filas: conservarPintadoEnVuelo(visible.filas, body.filas, enVuelo) };
      return true;
    },
    /**
     * El `pintar` del entorno del toggle: una escritura local, que no es una
     * respuesta y por eso no pasa por la secuencia. Mismo `filasConEstado` que
     * usa el componente.
     */
    pintar(objectId: string, status: string | null, siMuestra?: string | null): void {
      visible = { ...visible, filas: filasConEstado(visible.filas, objectId, status, siMuestra) };
    },
  };
}

function fila(objectId: string, status: string | null, spendEur = 0): Fila {
  return { objectId, status, spendEur };
}

// ─── 1. El contador ──────────────────────────────────────────────────────────

describe('el contador de pedidos (R5 c4)', () => {
  it('numera los pedidos al emitir, desde 1 y sin repetir', () => {
    const s = crearSecuencia();
    expect([s.emitir(), s.emitir(), s.emitir()]).toEqual([1, 2, 3]);
  });

  it('la primera respuesta se aplica: no hay nada más nuevo en pantalla', () => {
    const s = crearSecuencia();
    expect(s.aplicar(s.emitir())).toBe(true);
  });

  it('en orden se aplican todas', () => {
    const s = crearSecuencia();
    const uno = s.emitir();
    const dos = s.emitir();
    expect(s.aplicar(uno)).toBe(true);
    expect(s.aplicar(dos)).toBe(true);
  });

  it('la respuesta de un pedido anterior se descarta si ya llegó una posterior', () => {
    const s = crearSecuencia();
    const viejo = s.emitir();
    const nuevo = s.emitir();
    expect(s.aplicar(nuevo)).toBe(true);
    // El caso del bug: el pedido lento vuelve último y traía datos de antes.
    expect(s.aplicar(viejo)).toBe(false);
  });

  it('un pedido que falla no consume el lugar: la respuesta que sí llega se aplica', () => {
    const s = crearSecuencia();
    const queFalla = s.emitir();
    const queLlega = s.emitir();
    // El que falla no llama a `aplicar`, así que no mueve nada.
    expect(s.vigente(queFalla)).toBe(true);
    expect(s.aplicar(queLlega)).toBe(true);
    // Y comparar contra la última APLICADA y no contra la última emitida es lo
    // que permite esto: si se comparara contra `emitida`, una respuesta buena
    // quedaría descartada por un pedido posterior que nunca va a llegar.
    expect(s.vigente(queFalla)).toBe(false);
  });

  it('`vigente` no registra nada: preguntar dos veces da lo mismo', () => {
    const s = crearSecuencia();
    const uno = s.emitir();
    const dos = s.emitir();
    expect(s.vigente(dos)).toBe(true);
    expect(s.vigente(dos)).toBe(true);
    expect(s.aplicar(uno)).toBe(true);
    // El fallo del pedido 2 todavía tiene algo que decir: es posterior al único
    // cuerpo que se pintó.
    expect(s.vigente(dos)).toBe(true);
  });

  it('la misma respuesta no se aplica dos veces', () => {
    const s = crearSecuencia();
    const uno = s.emitir();
    expect(s.aplicar(uno)).toBe(true);
    expect(s.aplicar(uno)).toBe(false);
  });
});

// ─── 2. Las tres fuentes concurrentes ────────────────────────────────────────

describe('las tres fuentes que hoy conviven sin coordinación', () => {
  it('el Boton_Actualizar que vuelve tarde no pisa el pedido de filtros posterior', () => {
    const p = pantalla(cuerpo(0));
    // El usuario aprieta Actualizar: con `forzar` el endpoint espera el sync de
    // gasto y el de la Jerarquía antes de leer, y puede tardar 60 s.
    const actualizar = p.secuencia.emitir();
    // Mientras espera, cambia un filtro. Ese pedido no fuerza nada y vuelve ya.
    const filtros = p.secuencia.emitir();

    expect(p.aplicar(filtros, cuerpo(filtros))).toBe(true);
    expect(p.aplicar(actualizar, cuerpo(actualizar))).toBe(false);

    expect(p.visible.marca).toBe(filtros);
  });

  it('el refetch posterior a un lote no pisa un pedido emitido después', () => {
    const p = pantalla(cuerpo(0));
    const lote = p.secuencia.emitir(); // el refetch de ejecutarLote, 10 s de tope
    const tick = p.secuencia.emitir(); // el tick del polling, que salió después

    expect(p.aplicar(tick, cuerpo(tick))).toBe(true);
    expect(p.aplicar(lote, cuerpo(lote))).toBe(false);

    expect(p.visible.marca).toBe(tick);
  });

  it('si el pedido nuevo falla, la respuesta del anterior sí se pinta', () => {
    const p = pantalla(cuerpo(0));
    const viejo = p.secuencia.emitir();
    const nuevo = p.secuencia.emitir();

    // El nuevo se cae por red: no aplica nada.
    expect(p.secuencia.vigente(nuevo)).toBe(true);
    // El anterior llega bien y es lo más fresco que hay: descartarlo dejaría la
    // pantalla con datos viejos teniendo una respuesta buena en la mano.
    expect(p.aplicar(viejo, cuerpo(viejo))).toBe(true);
    expect(p.visible.marca).toBe(viejo);
  });
});

// ─── 3. El Pintado_Optimista mientras hay un pedido en vuelo ─────────────────

describe('las filas con un cambio de estado en vuelo (task 4.1 + task 12)', () => {
  it('sin nada en vuelo, las filas son exactamente las que llegaron', () => {
    const llegadas = [fila('s1', 'ACTIVE'), fila('s2', 'PAUSED')];
    // Misma referencia: sin ids en vuelo no hay nada que decidir ni que copiar.
    expect(conservarPintadoEnVuelo([fila('s1', 'PAUSED')], llegadas, new Set())).toBe(llegadas);
  });

  it('la fila con el pedido en vuelo conserva el status pintado y actualiza el resto', () => {
    const enPantalla = [fila('s1', 'ACTIVE', 10)]; // ACTIVE es el Pintado_Optimista
    const llegadas = [fila('s1', 'PAUSED', 25)]; // la lectura todavía dice PAUSED
    const salida = conservarPintadoEnVuelo(enPantalla, llegadas, new Set(['s1']));

    expect(salida).toEqual([fila('s1', 'ACTIVE', 25)]);
    // El gasto de esa fila sí se actualiza: lo único que el toggle escribió es
    // el estado, y congelar la fila entera esconderia números frescos.
    expect(salida[0]!.spendEur).toBe(25);
  });

  it('las filas sin pedido en vuelo se pintan con lo que llegó', () => {
    const enPantalla = [fila('s1', 'ACTIVE'), fila('s2', 'ACTIVE')];
    const llegadas = [fila('s1', 'PAUSED'), fila('s2', 'PAUSED')];

    expect(conservarPintadoEnVuelo(enPantalla, llegadas, new Set(['s1']))).toEqual([
      fila('s1', 'ACTIVE'),
      fila('s2', 'PAUSED'),
    ]);
  });

  it('conserva también un status nulo: el valor pintado puede no ser ACTIVE ni PAUSED', () => {
    const salida = conservarPintadoEnVuelo(
      [fila('s1', null)],
      [fila('s1', 'PAUSED')],
      new Set(['s1']),
    );
    expect(salida[0]!.status).toBeNull();
  });

  it('un id en vuelo que no vino en la respuesta no agrega ninguna fila', () => {
    const llegadas = [fila('s2', 'PAUSED')];
    expect(conservarPintadoEnVuelo([fila('s1', 'ACTIVE')], llegadas, new Set(['s1']))).toEqual(
      llegadas,
    );
  });

  it('mientras el pedido está en vuelo, ninguna respuesta cambia el estado de esa fila', () => {
    // Es el caso que la reversión de la task 4.1 no podía distinguir: una
    // respuesta que llega trayendo JUSTO el valor pintado. Con la fila congelada
    // mientras el pedido está en vuelo, si la fila muestra el pintado es porque
    // lo pintamos nosotros, y no porque el servidor lo haya confirmado.
    const p = pantalla(cuerpo(0, [fila('s1', 'PAUSED')]));
    // El id entra en vuelo antes del Pintado_Optimista, como en `ejecutarToggle`.
    p.enVuelo.add('s1');
    p.pintar('s1', 'ACTIVE');

    // Llega una lectura con el mismo valor que pintamos, y otra con el previo.
    expect(p.aplicar(p.secuencia.emitir(), cuerpo(1, [fila('s1', 'ACTIVE', 7)]))).toBe(true);
    expect(p.visible.filas[0]!.status).toBe('ACTIVE');
    expect(p.aplicar(p.secuencia.emitir(), cuerpo(2, [fila('s1', 'PAUSED', 9)]))).toBe(true);
    expect(p.visible.filas[0]!.status).toBe('ACTIVE');
    expect(p.visible.filas[0]!.spendEur).toBe(9);

    // Así la reversión encuentra lo que pintó y devuelve la fila a su valor
    // previo (R2 c3) sin riesgo de pisar una confirmación del servidor.
    p.pintar('s1', 'PAUSED', 'ACTIVE');
    p.enVuelo.delete('s1');
    expect(p.visible.filas[0]!.status).toBe('PAUSED');

    // Y con el pedido terminado, la fila vuelve a seguir al servidor.
    p.aplicar(p.secuencia.emitir(), cuerpo(3, [fila('s1', 'ACTIVE')]));
    expect(p.visible.filas[0]!.status).toBe('ACTIVE');
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────

/**
 * Un pedido: si su respuesta llega bien y en qué momento llega. El instante es
 * un entero chico a propósito, para que haya empates y se recorran órdenes de
 * llegada con pedidos que vuelven "a la vez".
 */
type Pedido = { ok: boolean; llegada: number };

const pedidosArbitrarios: fc.Arbitrary<Pedido[]> = fc.array(
  fc.record({ ok: fc.boolean(), llegada: fc.integer({ min: 0, max: 20 }) }),
  { minLength: 1, maxLength: 12 },
);

/** Todos llegan bien: la propiedad tal como la enuncia el design. */
const pedidosQueLleganArbitrarios: fc.Arbitrary<Pedido[]> = fc.array(
  fc.record({ ok: fc.constant(true), llegada: fc.integer({ min: 0, max: 20 }) }),
  { minLength: 1, maxLength: 12 },
);

/**
 * El orden de llegada: los pedidos ordenados por su instante, con el índice de
 * emisión como desempate. El `seq` es el índice + 1, o sea el número que
 * `emitir` les habría dado saliendo en orden.
 */
function ordenDeLlegada(pedidos: readonly Pedido[]): { seq: number; ok: boolean }[] {
  return pedidos
    .map((p, i) => ({ seq: i + 1, ok: p.ok, llegada: p.llegada, i }))
    .sort((a, b) => a.llegada - b.llegada || a.i - b.i)
    .map(({ seq, ok }) => ({ seq, ok }));
}

// Feature: frescura-y-acciones-anuncios, Property 7: Monotonía del estado de
// pantalla
//
// **Validates: Requirements 5.4**
describe('Property 7: Monotonía del estado de pantalla', () => {
  it('para todo orden de llegada, la pantalla queda con la respuesta del pedido de número más alto', () => {
    fc.assert(
      fc.property(pedidosQueLleganArbitrarios, (pedidos) => {
        const p = pantalla(cuerpo(0));
        // Los pedidos SALEN en orden: es lo único que el cliente sabe.
        for (const _ of pedidos) p.secuencia.emitir();

        for (const { seq } of ordenDeLlegada(pedidos)) p.aplicar(seq, cuerpo(seq));

        // Y la pantalla queda con el último EMITIDO, no con el último en llegar.
        expect(p.visible.marca).toBe(pedidos.length);
      }),
      { numRuns: 500 },
    );
  });

  it('con pedidos que fallan, queda la más alta de las respuestas que llegaron bien', () => {
    fc.assert(
      fc.property(pedidosArbitrarios, (pedidos) => {
        const p = pantalla(cuerpo(0));
        for (const _ of pedidos) p.secuencia.emitir();

        for (const { seq, ok } of ordenDeLlegada(pedidos)) {
          if (ok) p.aplicar(seq, cuerpo(seq));
        }

        const esperada = pedidos.reduce((max, q, i) => (q.ok ? Math.max(max, i + 1) : max), 0);
        // 0 es el cuerpo inicial: si ninguna respuesta llegó, la pantalla no se
        // tocó. Descartar no es un error y no borra lo que ya estaba.
        expect(p.visible.marca).toBe(esperada);
      }),
      { numRuns: 500 },
    );
  });

  it('el número del cuerpo en pantalla nunca decrece, y descartar no toca nada', () => {
    fc.assert(
      fc.property(pedidosArbitrarios, (pedidos) => {
        const p = pantalla(cuerpo(0));
        for (const _ of pedidos) p.secuencia.emitir();

        for (const { seq, ok } of ordenDeLlegada(pedidos)) {
          if (!ok) continue;
          const antes = p.visible;
          if (p.aplicar(seq, cuerpo(seq))) {
            // Aplicada: el número sube. Nunca al revés, que es el síntoma
            // reportado (los números de la pantalla se van para atrás solos).
            expect(p.visible.marca).toBeGreaterThan(antes.marca);
          } else {
            // Descartada: la misma referencia, sin re-render y sin aviso.
            expect(p.visible).toBe(antes);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it('para todo orden de llegada, el resultado es el mismo que si hubieran llegado en orden', () => {
    fc.assert(
      fc.property(pedidosArbitrarios, (pedidos) => {
        const desordenada = pantalla(cuerpo(0));
        const enOrden = pantalla(cuerpo(0));
        for (const _ of pedidos) {
          desordenada.secuencia.emitir();
          enOrden.secuencia.emitir();
        }

        for (const { seq, ok } of ordenDeLlegada(pedidos)) {
          if (ok) desordenada.aplicar(seq, cuerpo(seq));
        }
        for (let i = 0; i < pedidos.length; i += 1) {
          if (pedidos[i]!.ok) enOrden.aplicar(i + 1, cuerpo(i + 1));
        }

        // La forma fuerte de la propiedad: el orden de llegada deja de ser un
        // dato observable de la pantalla.
        expect(desordenada.visible).toEqual(enOrden.visible);
      }),
      { numRuns: 300 },
    );
  });

  it('una fila con un cambio de estado en vuelo conserva su status para todo orden de llegada', () => {
    fc.assert(
      fc.property(
        pedidosQueLleganArbitrarios,
        fc.constantFrom<string | null>('ACTIVE', 'PAUSED', null),
        (pedidos, pintado) => {
          const p = pantalla(cuerpo(0, [fila('s1', pintado), fila('s2', 'ACTIVE')]));
          p.enVuelo.add('s1');
          for (const _ of pedidos) p.secuencia.emitir();

          for (const { seq } of ordenDeLlegada(pedidos)) {
            // Cada lectura trae un estado cualquiera para las dos filas.
            p.aplicar(seq, cuerpo(seq, [fila('s1', 'PAUSED', seq), fila('s2', 'PAUSED', seq)]));
          }

          // La fila con la escritura en vuelo sigue mostrando lo que se pintó, así
          // la reversión de la task 4.1 puede confiar en su propia guarda.
          expect(p.visible.filas.find((f) => f.objectId === 's1')!.status).toBe(pintado);
          expect(p.visible.filas.find((f) => f.objectId === 's2')!.status).toBe('PAUSED');
        },
      ),
      { numRuns: 300 },
    );
  });
});
