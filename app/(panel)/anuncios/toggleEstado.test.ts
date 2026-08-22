import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dibujoDeEstado } from './celdas';
import {
  accionDeToggle,
  ejecutarToggle,
  filasConEstado,
  statusOptimista,
  type EntornoToggle,
} from './GestorAnuncios';
import { MOTIVO_TEXTO, type Aviso, type EstadoResultadoAccion, type MotivoOmision, type ResultadoAccion } from '@/lib/ads/mensajes';
import type { MetricasObjeto, NivelAds } from '@/lib/ads/tipos';

/**
 * Tests del toggle de estado (task 4.3 de frescura-y-acciones-anuncios).
 *
 * El bug que este archivo existe para que no vuelva: la dirección salía de
 * `status === 'PAUSED' ? 'activate' : 'pause'`, que manda `pause` para cualquier
 * valor que no sea literalmente `PAUSED`. Una fila con `status` nulo se dibujaba
 * apagada y al tocarla pedía pausar: el servidor la omitía por "ya está en ese
 * estado", el aviso decía `HTTP 200` y el conjunto quedaba imposible de encender
 * desde el panel. Es lo que se reportó como "el de habilitar conjunto parece que
 * lo habilita pero realmente no lo hace".
 *
 * ## Sin render, y qué se hizo para no perder cobertura
 *
 * `vitest.config.ts` corre en node por decisión explícita: sin jsdom, sin
 * testing-library, y su `include` sólo toma archivos `.test.ts`. Así que el
 * `toggleEstado` que vivía adentro del componente no se podía ejercitar de
 * ninguna forma, y las dos cosas que este spec vino a arreglar —la guarda de
 * doble disparo y la reversión— quedaban sin test.
 *
 * La task 4.3 movió tres piezas afuera, sin cambiar el comportamiento:
 *
 *   - `dibujoDeEstado` (celdas.tsx): con qué se dibuja la celda de estado. Es el
 *     predicado que antes vivía adentro del JSX, contra un `NO_TOGGLEABLE` sin
 *     exportar.
 *   - `filasConEstado` (GestorAnuncios.tsx): el Pintado_Optimista y su reversión
 *     condicional, que eran dos `.map` inline casi iguales.
 *   - `ejecutarToggle` (GestorAnuncios.tsx): la orquestación, con el entorno
 *     inyectado en lugar de capturado por closure.
 *
 * Los tests de abajo NO reimplementan nada: el `pintar` del entorno es el mismo
 * `filasConEstado` que le pasa el componente, y los pedidos se cuentan sobre el
 * `pedir` que el propio `ejecutarToggle` invoca, con el cuerpo que arma él. El
 * valor final de la fila y el `action` que viaja salen de código de producción.
 *
 * ## Lo único que queda sin cubrir
 *
 * El cableado JSX de `ToggleEstado`: que el `onClick` esté en la rama del
 * interruptor y que la rama del badge no tenga ninguno. Llamar al componente en
 * node no es posible —vitest transforma el JSX con el runtime clásico y
 * `celdas.tsx` no importa React— y montarlo pide jsdom, que es una decisión de
 * infraestructura de todo el repo y no de esta task. Lo que sostiene esa parte es
 * el tipo: `dibujoDeEstado` devuelve una unión donde la rama `badge` no tiene
 * `encendido`, así que la celda no puede derivar una posición de interruptor —ni
 * pedir una acción— para una fila que no dibuja interruptor.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Los cinco campos que el toggle mira: los cuatro que `ejecutarToggle` manda en
 * el pedido más el `effectiveStatus` con el que `dibujoDeEstado` decide. Fila
 * mínima y no `MetricasObjeto` completa a propósito: las dos funciones declaran
 * lo que leen con un `Pick`, así que el test no arrastra los cuarenta campos.
 */
type Fila = Pick<MetricasObjeto, 'objectId' | 'level' | 'accountId' | 'status' | 'effectiveStatus'>;

function fila(status: string | null, sobre: Partial<Fila> = {}): Fila {
  return { objectId: 's1', level: 'adset', accountId: 'act_1', status, effectiveStatus: status, ...sobre };
}

/** El cuerpo del pedido que arma `ejecutarToggle`, tal como sale por el cable. */
type CuerpoPedido = {
  level: NivelAds;
  accountId: string;
  action: 'pause' | 'activate';
  objectIds: string[];
};

/**
 * El componente reducido a lo que el toggle toca: la lista de filas, los avisos
 * que salieron a pantalla, los pedidos que salieron a la red y cuántos refetch
 * se pidieron. `responder` recibe el número de pedido (1, 2, …) para poder
 * contestar distinto a cada uno.
 */
function tabla(filas: Fila[], responder: (pedido: number) => Promise<Response>) {
  const registro = {
    filas,
    avisos: [] as Aviso[],
    pedidos: [] as CuerpoPedido[],
    urls: [] as string[],
    refrescos: 0,
  };

  const entorno: EntornoToggle = {
    enVuelo: new Set<string>(),
    // El MISMO reducer que usa el componente: el valor final de la fila no sale
    // de una reimplementación del test.
    pintar: (objectId, status, siMuestra) => {
      registro.filas = filasConEstado(registro.filas, objectId, status, siMuestra);
    },
    avisar: (a) => registro.avisos.push(a),
    refrescar: () => {
      registro.refrescos += 1;
    },
    pedir: (url, init) => {
      registro.urls.push(url);
      registro.pedidos.push(JSON.parse(String(init.body)) as CuerpoPedido);
      return responder(registro.pedidos.length);
    },
  };

  const statusDe = (objectId: string): string | null | undefined =>
    registro.filas.find((f) => f.objectId === objectId)?.status;

  return { registro, entorno, statusDe };
}

function resultado(sobre: Partial<ResultadoAccion> = {}): ResultadoAccion {
  return {
    objectId: 's1',
    objectName: 'Conjunto frío EUR',
    estado: 'confirmado',
    mensaje: null,
    codigoMeta: null,
    ...sobre,
  };
}

/** Una respuesta del Endpoint_Acciones con la forma que arma el route. */
function respuesta(httpStatus: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function con(...rs: readonly ResultadoAccion[]): unknown {
  return { ok: true, aplicados: 0, total: rs.length, corte: null, resultados: rs };
}

const CONFIRMADO = (): Response => respuesta(200, con(resultado({ estado: 'confirmado' })));

/** El caso reportado: 200, omitido, sin mensaje. El que mostraba «HTTP 200». */
const OMITIDO = (): Response =>
  respuesta(200, con(resultado({ estado: 'omitido', motivo: 'ya_esta_en_ese_estado', mensaje: null })));

/**
 * Las dos advertencias que el Preflight manda de verdad, copiadas literales de
 * `advertenciaPadreApagado` y `advertenciaDesaparecido` de
 * `lib/ads/previsualizacion.ts` (R6.4 y R3.4).
 *
 * Literales y no un `'algo'` cualquiera porque lo que estos tests tienen que
 * poder afirmar es que el usuario ve por qué el conjunto no entrega, y un
 * placeholder no lo dice. Si el texto de allá cambia, acá no rompe nada: lo que
 * se verifica es que la advertencia LLEGA al aviso y que no dispara la
 * reversión, no su redacción, que tiene sus propios tests en
 * `previsualizacion.test.ts` y `mensajes.test.ts`.
 */
const ADV_CAMPANIA =
  'la campaña está pausada: el conjunto queda activo pero no entrega hasta que se active la campaña';
const ADV_DESAPARECIDO = 'objeto desaparecido: Meta ya no lo devuelve y la escritura puede fallar';

/**
 * El desenlace que la task 15 agregó y que rompió el toggle: Meta confirmó la
 * escritura Y el objeto igual no va a entregar. Es un `confirmado` como el de
 * arriba, con `advertencia`.
 */
const CONFIRMADO_CON_ADVERTENCIA = (): Response =>
  respuesta(200, con(resultado({ estado: 'confirmado', advertencia: ADV_CAMPANIA })));

/** Una promesa que se resuelve cuando el test quiere: el pedido queda en vuelo. */
function enEspera(): { promesa: Promise<Response>; responder: (r: Response) => void } {
  let responder!: (r: Response) => void;
  const promesa = new Promise<Response>((res) => {
    responder = res;
  });
  return { promesa, responder };
}

// ─── 1. La dirección ─────────────────────────────────────────────────────────

/**
 * Cada valor de `status` con el que la celda dibuja un interruptor, la posición
 * en la que lo dibuja y la acción que le corresponde. Todas las filas menos la
 * primera son las que la versión anterior mandaba a pausar: su comparación era
 * contra `'PAUSED'`, así que cualquier otro valor —nulo, vacío, un estado
 * heredado o uno que este cliente no conoce— pedía pausar una fila que estaba
 * dibujada apagada.
 */
const DIRECCIONES: readonly (readonly [string | null, boolean, 'pause' | 'activate'])[] = [
  ['ACTIVE', true, 'pause'],
  ['PAUSED', false, 'activate'],
  [null, false, 'activate'],
  ['', false, 'activate'],
  ['ADSET_PAUSED', false, 'activate'],
  ['CAMPAIGN_PAUSED', false, 'activate'],
  ['active', false, 'activate'], // Meta manda mayúsculas: minúscula es un valor inesperado
  ['UN_ESTADO_QUE_NO_CONOCEMOS', false, 'activate'],
];

describe('la dirección del toggle (R2 c1, c2)', () => {
  for (const [status, encendido, accion] of DIRECCIONES) {
    it(`status ${JSON.stringify(status)} se dibuja ${encendido ? 'encendido' : 'apagado'} y pide ${accion}`, async () => {
      const f = fila(status);

      const dibujo = dibujoDeEstado(f);
      expect(dibujo).toEqual({ control: 'interruptor', encendido });
      expect(accionDeToggle(status)).toBe(accion);
      // El núcleo de la coherencia: lo dibujado y lo pedido son inversos.
      expect(encendido).toBe(accion === 'pause');

      // Y es lo que sale por el cable, no sólo lo que devuelve la función pura.
      const { registro, entorno } = tabla([f], async () => CONFIRMADO());
      await ejecutarToggle(f, entorno);
      expect(registro.urls).toEqual(['/api/ads/acciones']);
      expect(registro.pedidos).toEqual([
        { level: 'adset', accountId: 'act_1', action: accion, objectIds: ['s1'] },
      ]);
    });
  }

  it('los estados que no se pueden escribir dibujan un badge, y un badge no tiene posición ni acción', () => {
    // La celda devuelve la rama `badge`, que no lleva `encendido`: no hay de
    // dónde derivar una dirección, así que la fila no se togglea. El `onClick`
    // vive en la otra rama de `ToggleEstado`.
    for (const s of ['ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']) {
      expect(dibujoDeEstado(fila(s))).toEqual({ control: 'badge', texto: s });
      // Alcanza con que lo diga el estado efectivo: un anuncio activo dentro de
      // un conjunto rechazado tampoco se togglea.
      expect(dibujoDeEstado(fila('ACTIVE', { effectiveStatus: s }))).toEqual({
        control: 'badge',
        texto: s,
      });
      // Y el badge dice el estado que hay, no queda vacío: con `effective_status`
      // en blanco el `??` de la versión anterior dibujaba un badge de
      // advertencia sin texto. Lo encontró la Property 1.
      expect(dibujoDeEstado(fila(s, { effectiveStatus: '' }))).toEqual({
        control: 'badge',
        texto: s,
      });
    }
  });

  it('el Pintado_Optimista deja la fila del otro lado, así el interruptor vuelve a ser accionable', () => {
    // Sin esto el toggle sería de una sola dirección, que es exactamente lo que
    // pasaba con `status` nulo.
    expect(statusOptimista(accionDeToggle('ACTIVE'))).toBe('PAUSED');
    expect(statusOptimista(accionDeToggle('PAUSED'))).toBe('ACTIVE');
    expect(statusOptimista(accionDeToggle(null))).toBe('ACTIVE');
    expect(accionDeToggle(statusOptimista(accionDeToggle(null)))).toBe('pause');
  });
});

// ─── 2. La guarda de doble disparo ───────────────────────────────────────────

describe('la guarda de pedidos en vuelo (R2 c8)', () => {
  it('dos clicks seguidos sobre la misma fila producen UN solo pedido', async () => {
    const espera = enEspera();
    const f = fila('PAUSED');
    const { registro, entorno } = tabla([f], () => espera.promesa);

    const primero = ejecutarToggle(f, entorno); // queda en vuelo
    await ejecutarToggle(f, entorno); // la guarda lo corta sin tocar la red
    expect(registro.pedidos).toHaveLength(1);

    espera.responder(CONFIRMADO());
    await primero;
    // En producción quedaron dos filas `activate confirmado` sobre el mismo
    // conjunto separadas por un segundo: eso es lo que no puede volver a pasar.
    expect(registro.pedidos).toHaveLength(1);
    expect(registro.refrescos).toBe(1);
  });

  it('dos filas distintas a la vez son legítimas: dos pedidos', async () => {
    const espera = enEspera();
    const a = fila('PAUSED', { objectId: 's1' });
    const b = fila('ACTIVE', { objectId: 's2' });
    const { registro, entorno } = tabla([a, b], () => espera.promesa);

    const ambos = Promise.all([ejecutarToggle(a, entorno), ejecutarToggle(b, entorno)]);
    expect(registro.pedidos).toHaveLength(2);
    expect(registro.pedidos.map((p) => p.action)).toEqual(['activate', 'pause']);

    espera.responder(CONFIRMADO());
    await ambos;
  });

  it('cuando el pedido termina la fila vuelve a ser accionable', async () => {
    const f = fila('PAUSED');
    const { registro, entorno } = tabla([f], async () => CONFIRMADO());

    await ejecutarToggle(f, entorno);
    await ejecutarToggle(f, entorno);
    // La guarda es por pedido en vuelo, no un bloqueo permanente: sin el
    // `delete` del finally la fila quedaba muerta hasta recargar la página.
    expect(registro.pedidos).toHaveLength(2);
    expect(entorno.enVuelo.size).toBe(0);
  });

  it('la guarda se libera también cuando el pedido falla', async () => {
    const f = fila('PAUSED');
    const { registro, entorno } = tabla([f], async () => {
      throw new Error('network');
    });

    await ejecutarToggle(f, entorno);
    expect(entorno.enVuelo.size).toBe(0);
    await ejecutarToggle(f, entorno);
    expect(registro.pedidos).toHaveLength(2);
  });
});

// ─── 3. La reversión ─────────────────────────────────────────────────────────

describe('la reversión del Pintado_Optimista (R2 c3)', () => {
  it('una Omisión deja la fila en su valor original y avisa el motivo en castellano', async () => {
    const f = fila('PAUSED');
    const { registro, statusDe, entorno } = tabla([f], async () => OMITIDO());

    await ejecutarToggle(f, entorno);

    expect(statusDe('s1')).toBe('PAUSED');
    expect(registro.avisos).toHaveLength(1);
    expect(registro.avisos[0]!.tono).toBe('aviso');
    expect(registro.avisos[0]!.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    // El síntoma exacto que se veía en pantalla (R2 c6, Property 3).
    expect(registro.avisos[0]!.texto).not.toContain('200');
    // Sin cambio en la base no hay nada que releer, y un refetch sólo podría
    // deshacer la reversión con el mismo dato viejo que causó la Omisión.
    expect(registro.refrescos).toBe(0);
  });

  it('la fila vuelve a `null`, no a PAUSED: el valor previo puede no ser ninguno de los dos', async () => {
    const f = fila(null);
    const { statusDe, entorno } = tabla([f], async () => OMITIDO());

    await ejecutarToggle(f, entorno);

    // Es la fila del bug reportado. Revertir a 'PAUSED' habría inventado un
    // estado que Meta nunca confirmó.
    expect(statusDe('s1')).toBeNull();
  });

  it('un error de red también revierte, y el aviso no lo presenta como éxito ni como fallo', async () => {
    const f = fila('ACTIVE');
    const { registro, statusDe, entorno } = tabla([f], async () => {
      throw new Error('Failed to fetch');
    });

    await ejecutarToggle(f, entorno);

    expect(statusDe('s1')).toBe('ACTIVE');
    expect(registro.avisos[0]!.texto).toContain('Failed to fetch');
    expect(registro.avisos[0]!.texto).toContain('reconciliación');
    expect(registro.refrescos).toBe(0);
  });

  it('un confirmado deja el valor pintado, sin aviso y con un refetch', async () => {
    const f = fila('PAUSED');
    const { registro, statusDe, entorno } = tabla([f], async () => CONFIRMADO());

    await ejecutarToggle(f, entorno);

    expect(statusDe('s1')).toBe('ACTIVE');
    expect(registro.avisos).toHaveLength(0);
    expect(registro.refrescos).toBe(1);
  });

  /**
   * El caso que la task 15 rompió, y el motivo por el que la condición de
   * reversión mira `aplicado` en lugar de la nulidad del aviso.
   *
   * Activar un conjunto cuya campaña está pausada: Meta escribe ACTIVE y lo
   * confirma, y el Preflight adjunta la advertencia de R6.4 porque el objeto no
   * va a entregar hasta que se prenda el padre. Con `if (av !== null)` como
   * única condición, ese aviso mandaba a revertir: la fila volvía a PAUSED
   * mientras el texto decía "el cambio se aplicó en Meta". El espejo exacto del
   * bug reportado —el panel afirmando en pantalla algo que no coincide con
   * Meta— sólo que por el otro lado.
   *
   * Que la advertencia no sea un fallo es lo que R6.4 pide explícitamente
   * ("DEBE distinguir ese caso de un fallo de la acción"). Que el aviso llegue
   * marcado con `aplicado: true` sólo cuando el desenlace fue `confirmado` es
   * invariante de `lib/ads/mensajes.ts`, verificada en su test ("sólo el
   * confirmado se marca como aplicado" y su Property 2): acá se apoya en eso, no
   * se repite.
   */
  it('un confirmado CON advertencia deja el valor pintado, avisa que se aplicó y refresca (R6.4)', async () => {
    const f = fila('PAUSED');
    const { registro, statusDe, entorno } = tabla([f], async () => CONFIRMADO_CON_ADVERTENCIA());

    await ejecutarToggle(f, entorno);

    // Lo que este test existe para fijar: la fila NO vuelve.
    expect(statusDe('s1')).toBe('ACTIVE');

    // Y hay algo que decir, con las dos mitades: que quedó aplicado y que igual
    // no entrega. Tono `aviso` y no `error`: nada falló.
    expect(registro.avisos).toHaveLength(1);
    expect(registro.avisos[0]!.tono).toBe('aviso');
    expect(registro.avisos[0]!.aplicado).toBe(true);
    expect(registro.avisos[0]!.texto).toContain('El cambio se aplicó en Meta.');
    expect(registro.avisos[0]!.texto).toContain('no entrega hasta que se active la campaña');

    // El refetch se pide igual que en el confirmado sin advertencia: el route
    // hace `refrescarJerarquia` —lectura del objeto contra Meta y UPDATE de
    // status, effective_status y synced_at— ANTES de responder, así que esta
    // relectura trae el valor de Meta (R4 c7). La advertencia no lo cambia: el
    // `effective_status` que va a traer (CAMPAIGN_PAUSED) es justamente lo que
    // el aviso está anunciando.
    expect(registro.refrescos).toBe(1);
  });

  it('la reversión no pisa un valor más nuevo que llegó mientras el pedido estaba en vuelo', async () => {
    const espera = enEspera();
    const f = fila('ACTIVE');
    const { registro, statusDe, entorno } = tabla([f], () => espera.promesa);

    const enCurso = ejecutarToggle(f, entorno); // pinta PAUSED
    expect(statusDe('s1')).toBe('PAUSED');

    // Llega una respuesta del endpoint de datos con lo que Meta dice ahora.
    registro.filas = filasConEstado(registro.filas, 's1', 'ARCHIVED');

    espera.responder(OMITIDO());
    await enCurso;

    // Ese valor es más nuevo que nuestro previo: devolver la fila a 'ACTIVE'
    // sería llevarla a un pasado.
    expect(statusDe('s1')).toBe('ARCHIVED');
    expect(registro.avisos).toHaveLength(1);
  });

  it('sólo se toca la fila del pedido', async () => {
    const a = fila('ACTIVE', { objectId: 's1' });
    const b = fila('ACTIVE', { objectId: 's2' });
    const { statusDe, entorno } = tabla([a, b], async () => OMITIDO());

    await ejecutarToggle(a, entorno);

    expect(statusDe('s1')).toBe('ACTIVE');
    expect(statusDe('s2')).toBe('ACTIVE');
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────

/**
 * Todo valor de `status` que puede llegar en una fila: los que Meta documenta,
 * los efectivos que aparecen en `effectiveStatus`, los que este cliente no
 * conoce, la cadena vacía, minúsculas y texto al azar. El peso está en los
 * conocidos para que las ramas que importan se recorran seguido, y el texto libre
 * está para que ningún caso quede afuera por no habérsele ocurrido a nadie.
 */
const statusArbitrario: fc.Arbitrary<string | null> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom(
      'ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES',
      'PENDING_REVIEW', 'IN_PROCESS', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
      'PENDING_BILLING_INFO', 'active', 'Active', 'paused', '',
    ),
  },
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.string({ maxLength: 24 }) },
);

const filaArbitraria: fc.Arbitrary<Fila> = fc
  .tuple(statusArbitrario, statusArbitrario, fc.constantFrom<NivelAds>('campaign', 'adset', 'ad'))
  .map(([status, effectiveStatus, level]) => fila(status, { effectiveStatus, level }));

const MOTIVOS = Object.keys(MOTIVO_TEXTO) as MotivoOmision[];

const ESTADOS: readonly EstadoResultadoAccion[] = [
  'confirmado',
  'fallido',
  'indeterminado',
  'omitido',
  'no_intentado',
];

/**
 * Las cuatro formas en las que una respuesta puede volver del Endpoint_Acciones,
 * con los cuerpos que el route arma de verdad: un resultado por objeto, un
 * rechazo del sobre (esquema, guard, 500), un cuerpo ilegible (el 502 del proxy
 * con HTML) y la red que se cae antes de responder.
 */
type FormaRespuesta =
  | {
      tipo: 'resultado';
      httpStatus: number;
      estado: EstadoResultadoAccion;
      motivo: MotivoOmision | undefined;
      mensaje: string | null;
      /**
       * La advertencia del Preflight, independiente del desenlace: el objeto
       * puede no entregar tanto si la escritura se aplicó como si se omitió. Es
       * el campo que faltaba en este generador, y por eso la Property 2 pasaba
       * verde con `volvio === aviso` después de que la task 15 dejara de cumplir
       * esa equivalencia.
       */
      advertencia: string | null;
    }
  | { tipo: 'sobre'; httpStatus: number; error: string | null; detail: string | null }
  | { tipo: 'ilegible'; httpStatus: number }
  | { tipo: 'red' };

const formaArbitraria: fc.Arbitrary<FormaRespuesta> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      tipo: fc.constant('resultado' as const),
      httpStatus: fc.constantFrom(200, 207),
      estado: fc.constantFrom(...ESTADOS),
      motivo: fc.option(fc.constantFrom(...MOTIVOS), { nil: undefined }),
      // La cadena vacía incluida: un `mensaje: ''` es un mensaje ausente y no
      // puede convertirse en un aviso en blanco.
      mensaje: fc.option(fc.constantFrom('', 'Meta rechazó el cambio', 'token vencido'), { nil: null }),
      // Las cuatro formas en las que la advertencia llega: ausente, presente por
      // un motivo, por el otro, y las dos juntas con el ` · ` que las une. Con
      // `''` entre los valores por lo mismo que en `mensaje`: el servidor no
      // dijo nada, así que no puede salir un aviso vacío ni —peor acá— un aviso
      // que impida la reversión de un cambio que no se aplicó.
      //
      // Cruzada contra los cinco desenlaces a propósito: la advertencia es del
      // objeto y no del pedido, así que el generador no la ata a `confirmado`.
      // Eso es lo que hace que la propiedad distinga «hay aviso» de «se aplicó»
      // en vez de encontrar las dos cosas siempre juntas.
      advertencia: fc.option(
        fc.constantFrom('', ADV_CAMPANIA, ADV_DESAPARECIDO, `${ADV_CAMPANIA} · ${ADV_DESAPARECIDO}`),
        { nil: null },
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      tipo: fc.constant('sobre' as const),
      httpStatus: fc.constantFrom(400, 401, 500),
      error: fc.option(fc.constantFrom('', 'invalid_payload', 'unauthorized'), { nil: null }),
      detail: fc.option(fc.constantFrom('', 'Required', 'budgetEur: mínimo 0.01'), { nil: null }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ tipo: fc.constant('ilegible' as const), httpStatus: fc.constantFrom(200, 502) }),
  },
  { weight: 1, arbitrary: fc.constant({ tipo: 'red' as const }) },
);

/** La respuesta HTTP de una forma generada, o una promesa rota si es la red. */
function respuestaDe(forma: FormaRespuesta): Promise<Response> {
  switch (forma.tipo) {
    case 'resultado':
      return Promise.resolve(
        respuesta(
          forma.httpStatus,
          con(
            resultado({
              estado: forma.estado,
              motivo: forma.motivo,
              mensaje: forma.mensaje,
              advertencia: forma.advertencia,
            }),
          ),
        ),
      );
    case 'sobre':
      return Promise.resolve(
        respuesta(forma.httpStatus, { ok: false, error: forma.error, detail: forma.detail }),
      );
    case 'ilegible':
      // Lo que devuelve un proxy caído: HTML donde el cliente espera JSON.
      return Promise.resolve(
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: forma.httpStatus,
          headers: { 'content-type': 'text/html' },
        }),
      );
    case 'red':
      return Promise.reject(new Error('Failed to fetch'));
  }
}

/**
 * Si la respuesta confirmó el cambio, leído del CUERPO y no de
 * `mensajeDeResultado`: la propiedad tiene que clasificar por su cuenta, o
 * estaría comparando la implementación consigo misma.
 *
 * `confirmado` es el único desenlace en el que la escritura quedó, con
 * advertencia o sin ella: la advertencia habla de si el objeto va a entregar, no
 * de si Meta aceptó el cambio.
 */
function confirmoElCambio(forma: FormaRespuesta): boolean {
  return forma.tipo === 'resultado' && forma.estado === 'confirmado';
}

/**
 * Si la respuesta trae una advertencia que MOSTRAR, leída del cuerpo con el
 * mismo criterio: `''` cuenta como ausente, igual que en `textoONulo` de
 * `mensajes.ts`, porque un servidor que manda la cadena vacía no dijo nada.
 *
 * Es la otra mitad de "hay algo que decir": un desenlace que no aplicó siempre
 * lo es, y un `confirmado` lo es sólo cuando además viene esto.
 */
function hayAdvertencia(forma: FormaRespuesta): boolean {
  return forma.tipo === 'resultado' && forma.advertencia !== null && forma.advertencia !== '';
}

// Feature: frescura-y-acciones-anuncios, Property 1: Coherencia entre lo que se
// dibuja y lo que se pide
//
// **Validates: Requirements 2.1, 2.2**
describe('Property 1: Coherencia entre lo que se dibuja y lo que se pide', () => {
  it('para todo status, la fila dibujada apagada pide activar y la dibujada encendida pide pausar', async () => {
    await fc.assert(
      fc.asyncProperty(filaArbitraria, async (f) => {
        const dibujo = dibujoDeEstado(f);

        // La fila que dibuja un badge no se togglea: no hay dirección que
        // verificar porque la rama del tipo no tiene ninguna.
        if (dibujo.control === 'badge') {
          expect(dibujo.texto.length).toBeGreaterThan(0);
          return;
        }

        const accion = accionDeToggle(f.status);
        expect(dibujo.encendido).toBe(accion === 'pause');

        // Y lo que viaja en el pedido es esa misma acción: la coherencia no se
        // rompe entre la función pura y el cuerpo que se manda.
        const { registro, entorno } = tabla([f], async () => CONFIRMADO());
        await ejecutarToggle(f, entorno);
        expect(registro.pedidos[0]!.action).toBe(accion);
        expect(registro.pedidos[0]!.objectIds).toEqual([f.objectId]);
      }),
      { numRuns: 300 },
    );
  });

  it('para todo status, el interruptor queda accionable en la otra dirección', async () => {
    await fc.assert(
      fc.asyncProperty(filaArbitraria, async (f) => {
        const dibujo = dibujoDeEstado(f);
        if (dibujo.control === 'badge') return;

        const accion = accionDeToggle(f.status);
        const { statusDe, entorno } = tabla([f], async () => CONFIRMADO());
        await ejecutarToggle(f, entorno);

        // El estado que quedó en la fila después del cambio confirmado.
        const despues = statusDe(f.objectId) ?? null;
        expect(despues).toBe(statusOptimista(accion));

        const dibujoDespues = dibujoDeEstado({ ...f, status: despues });
        // Sigue siendo un interruptor (ni ACTIVE ni PAUSED son no toggleables) y
        // quedó del otro lado: sin esto el control sería de una sola dirección,
        // que es el bug reportado.
        expect(dibujoDespues).toEqual({ control: 'interruptor', encendido: !dibujo.encendido });
        expect(accionDeToggle(despues)).not.toBe(accion);
      }),
      { numRuns: 300 },
    );
  });
});

// Feature: frescura-y-acciones-anuncios, Property 2: No hay éxito silencioso
//
// **Validates: Requirements 2.3, 2.6**
describe('Property 2: No hay éxito silencioso', () => {
  it('para toda respuesta sin confirmar, la fila vuelve a su valor y hay un aviso no vacío', async () => {
    await fc.assert(
      fc.asyncProperty(filaArbitraria, formaArbitraria, async (f, forma) => {
        const { registro, statusDe, entorno } = tabla([f], () => respuestaDe(forma));

        await ejecutarToggle(f, entorno);

        if (confirmoElCambio(forma)) {
          // El único desenlace que deja la fila cambiada, con advertencia o sin
          // ella: la advertencia dice que el objeto no entrega, no que la
          // escritura no ocurrió (R6.4).
          expect(statusDe(f.objectId)).toBe(statusOptimista(accionDeToggle(f.status)));
          // Sin advertencia no hay nada que decir; con advertencia hay algo que
          // decir que NO es un fallo, y se dice sin tocar la fila.
          expect(registro.avisos).toHaveLength(hayAdvertencia(forma) ? 1 : 0);
          for (const a of registro.avisos) expect(a.texto.trim().length).toBeGreaterThan(0);
          expect(registro.refrescos).toBe(1);
          return;
        }

        // Las dos mitades de la propiedad, juntas: la fila vuelve y se avisa.
        expect(statusDe(f.objectId)).toBe(f.status);
        expect(registro.avisos).toHaveLength(1);
        expect(registro.avisos[0]!.texto.trim().length).toBeGreaterThan(0);
        expect(registro.refrescos).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * La misma invariante dicha en términos de lo que tiene que valer, y no de lo
   * que se veía en pantalla.
   *
   * Esta mitad decía `volvio === aviso`: "la fila vuelve si y sólo si hay
   * aviso". Era cierto mientras `mensajeDeResultado` devolvía `null` en un solo
   * caso, así que "hay aviso" y "el cambio no quedó" eran la misma cosa. La
   * task 15 las separó —un `confirmado` con advertencia avisa Y quedó aplicado—
   * y desde entonces esa formulación pide lo contrario de lo que corresponde:
   * revertir una escritura que Meta confirmó.
   *
   * Las dos condiciones ahora se nombran por separado y contra el cuerpo de la
   * respuesta, no contra el aviso:
   *
   *   - la fila vuelve ⟺ el cambio NO quedó (R2 c3)
   *   - hay aviso      ⟺ hay algo que decir: o no quedó, o quedó y no entrega
   *
   * Sigue atrapando lo que atrapaba: sacar la reversión deja `volvio` en false
   * con `!aplicado` en true y la primera igualdad falla; dejar de avisar un
   * desenlace cualquiera hace fallar la segunda. Y atrapa además lo nuevo:
   * revertir un confirmado con advertencia pone `volvio` en true con `!aplicado`
   * en false.
   */
  it('la fila vuelve si y sólo si el cambio no quedó, y se avisa siempre que haya algo que decir', async () => {
    await fc.assert(
      fc.asyncProperty(filaArbitraria, formaArbitraria, async (f, forma) => {
        const { registro, statusDe, entorno } = tabla([f], () => respuestaDe(forma));

        await ejecutarToggle(f, entorno);

        const aplicado = confirmoElCambio(forma);
        const volvio = statusDe(f.objectId) === f.status;
        const aviso = registro.avisos.length > 0;

        // El Pintado_Optimista siempre deja un valor distinto del previo
        // (`ACTIVE` → `PAUSED`, cualquier otro → `ACTIVE`), así que "la fila
        // muestra su valor previo" es exactamente "se revirtió".
        expect(volvio, `volvio con ${JSON.stringify(forma)}`).toBe(!aplicado);
        expect(aviso, `aviso con ${JSON.stringify(forma)}`).toBe(!aplicado || hayAdvertencia(forma));
      }),
      { numRuns: 300 },
    );
  });
});
