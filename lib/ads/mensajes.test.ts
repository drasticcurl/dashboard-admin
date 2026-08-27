import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MOTIVO_TEXTO,
  avisoDeLote,
  mensajeDeResultado,
  type Aviso,
  type CuerpoAcciones,
  type EstadoResultadoAccion,
  type MotivoOmision,
  type ResultadoAccion,
} from './mensajes';
// El productor REAL de las advertencias que el servidor manda (task 15): los
// casos de abajo usan su salida en lugar de copiarse la frase, así que no pueden
// quedar verificando un texto que ya nadie emite.
import { advertenciaPadreApagado } from './previsualizacion';

/**
 * Tests de `mensajeDeResultado` (task 2.2 de frescura-y-acciones-anuncios).
 *
 * El caso que este archivo existe para que no vuelva: el Endpoint_Acciones
 * responde `200` con `resultados: [{ estado: 'omitido', mensaje: null }]`, el
 * toggle hace `mensaje ?? \`HTTP ${status}\``, el `??` cae a la derecha y la
 * pantalla muestra **HTTP 200** — un código de éxito presentado como error, que
 * además no dice nada de lo único que importaba (que el objeto se omitió porque
 * la copia local ya lo creía en ese estado). Es el síntoma reportado como
 * "activar no activa nada" (R2 c6).
 *
 * Tres cosas se fijan acá, y la tercera es la que da la garantía:
 *
 * 1. **Una rama por regla**, en el orden del design §5. Las seis reglas se
 *    pisan entre sí a propósito (un `omitido` también tiene `mensaje`, un
 *    rechazo también tiene `error` y `detail`), así que cuál gana no es un
 *    detalle de implementación: es el texto que el usuario lee, y va pinneado
 *    caso por caso.
 * 2. **Ningún aviso vacío.** `avisoDe` verifica largo > 0 en cada rama: un aviso
 *    en blanco sería un éxito silencioso, que es la mitad de la Property 2. La
 *    versión de propiedad de eso está al final del archivo, y es la que encontró
 *    el `mensaje: ''` que la regla 4 dejaba pasar. El detalle está escrito ahí.
 * 3. **Property 3**, abajo: para todo status 2xx y todo cuerpo, el texto no
 *    contiene el código. El argumento por el que la propiedad es concluyente y
 *    no un azar del generador está escrito arriba de ella.
 *
 * Función pura: sin base, sin red y sin React, así que no hay nada que mockear.
 * Los cuerpos se escriben a mano con la forma exacta que arma
 * `app/api/ads/acciones/route.ts`, no con un mock del fetch: lo que se testea es
 * la traducción, no el transporte.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Un resultado por objeto, con los campos que ninguna regla mira ya puestos. */
function resultado(over: Partial<ResultadoAccion> = {}): ResultadoAccion {
  return {
    objectId: '613487905136',
    objectName: 'Conjunto frío EUR',
    estado: 'confirmado',
    mensaje: null,
    codigoMeta: null,
    ...over,
  };
}

/** El cuerpo `200` del Endpoint_Acciones, con la forma que arma el route. */
function cuerpoCon(...rs: readonly ResultadoAccion[]): CuerpoAcciones {
  return { ok: true, aplicados: 0, total: rs.length, corte: null, resultados: rs };
}

/**
 * El aviso, exigiendo que exista y que no esté vacío (Property 2). Devuelve el
 * `Aviso` estrechado para que cada caso pueda mirar `tono` y `texto` sin repetir
 * el chequeo de nulidad.
 */
function avisoDe(httpStatus: number, cuerpo: CuerpoAcciones | null | undefined): Aviso {
  const a = mensajeDeResultado(httpStatus, cuerpo);
  if (a === null) throw new Error('se esperaba un aviso y el traductor devolvió null');
  expect(a.texto.length, 'un aviso sin texto es un éxito silencioso').toBeGreaterThan(0);
  return a;
}

/** Los seis motivos, leídos del catálogo para que sumar uno no pueda quedar sin test. */
const MOTIVOS = Object.keys(MOTIVO_TEXTO) as MotivoOmision[];

// ─── El bug reportado ────────────────────────────────────────────────────────

describe('el 200 que se mostraba como error (R2 c6)', () => {
  it('un omitido con mensaje null bajo un status 200 explica la omisión y NO nombra el 200', () => {
    const a = avisoDe(
      200,
      cuerpoCon(resultado({ estado: 'omitido', mensaje: null, motivo: 'ya_esta_en_ese_estado' })),
    );
    expect(a.tono).toBe('aviso'); // ni éxito ni error: el cambio no se aplicó, y no falló nada
    expect(a.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(a.texto).not.toContain('200');
    expect(a.texto).not.toContain('HTTP');
  });

  it('tampoco lo nombra cuando además falta el motivo, que es el peor caso', () => {
    // Sin motivo y sin mensaje no hay nada que contar del objeto, y es justo el
    // cuerpo con el que el `??` caía al código HTTP.
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'omitido', mensaje: null })));
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain('omitió el objeto sin llamar a Meta');
    expect(a.texto).not.toContain('200');
  });
});

// ─── Una rama por regla, en el orden del design §5 ───────────────────────────

describe('regla 1: confirmado no dice nada', () => {
  it('un primer resultado confirmado devuelve null', () => {
    expect(mensajeDeResultado(200, cuerpoCon(resultado({ estado: 'confirmado' })))).toBeNull();
  });

  it('sólo mira el PRIMER resultado: un fallido detrás de un confirmado no genera aviso', () => {
    // El toggle manda un objeto por pedido, así que el primero es el suyo. Se
    // pinnea porque el lote comparte el traductor y ahí sí vienen varios: el
    // desglose de un lote lo muestra `ResultadosLote`, no este aviso.
    const c = cuerpoCon(
      resultado({ estado: 'confirmado' }),
      resultado({ estado: 'fallido', mensaje: 'Meta rechazó el cambio.' }),
    );
    expect(mensajeDeResultado(200, c)).toBeNull();
  });
});

describe('regla 2: omitido usa el catálogo de motivos (R2 c4, R6 c1)', () => {
  it('los seis motivos producen un aviso con su texto del catálogo', () => {
    expect(MOTIVOS).toHaveLength(6);
    for (const motivo of MOTIVOS) {
      const a = avisoDe(200, cuerpoCon(resultado({ estado: 'omitido', mensaje: null, motivo })));
      expect(a.tono, `tono de ${motivo}`).toBe('aviso');
      expect(a.texto, `texto de ${motivo}`).toContain(MOTIVO_TEXTO[motivo]);
      // Es una cláusula que sigue a un "porque": si el catálogo dejara de serlo,
      // la frase quedaría rota y este contains lo tapa, así que se pinnea la forma.
      expect(a.texto).toContain('El cambio no se aplicó porque');
    }
  });

  it('el catálogo le gana al mensaje del servidor, para no nombrar el motivo de dos maneras', () => {
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          motivo: 'ya_esta_en_ese_estado',
          mensaje: 'El objeto ya estaba en ese estado.',
        }),
      ),
    );
    expect(a.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(a.texto).not.toContain('El objeto ya estaba en ese estado.');
  });

  it('sin motivo pero con mensaje del servidor, usa el mensaje', () => {
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          mensaje: 'el conjunto ya arrancó y su inicio no se puede cambiar',
        }),
      ),
    );
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain('el conjunto ya arrancó');
  });

  it('un motivo que este cliente todavía no conoce cae al mensaje del servidor, no a la clave cruda', () => {
    // El servidor puede desplegar un motivo nuevo antes que el cliente. Mostrar
    // `motivo_flamante` en pantalla sería peor que mostrar el texto del server.
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          motivo: 'motivo_flamante' as MotivoOmision,
          mensaje: 'el objeto no admite este cambio',
        }),
      ),
    );
    expect(a.texto).toContain('el objeto no admite este cambio');
    expect(a.texto).not.toContain('motivo_flamante');
  });

  it('un mensaje vacío cuenta como ausente y cae al texto fijo', () => {
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'omitido', mensaje: '' })));
    expect(a.texto).toContain('omitió el objeto sin llamar a Meta');
  });
});

// ─── La antigüedad del dato con el que se decidió (task 14.3) ────────────────
//
// R6.1 pide DOS cosas en el mismo mensaje: la razón de la Omisión y la
// antigüedad del dato con el que se decidió. El bloque de arriba fija la
// primera; acá va la segunda, que es la que separa «el botón no hizo nada» de
// «el panel decidió con una foto de hace cinco días».
//
// El valor lo arma `edadDelDatoDeOmision` de `lib/ads/acciones.ts` (task 14.3) y
// llega YA formateado: los casos de abajo usan sus tres formas reales, y el
// redondeo se verifica de ese lado, en `acciones.antiguedad.test.ts`.
describe('regla 2: la Omisión nombra la antigüedad del dato (R6 c1)', () => {
  it('el motivo y la edad van en el mismo aviso', () => {
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          mensaje: null,
          motivo: 'ya_esta_en_ese_estado',
          edadDelDato: 'de hace 5 d',
        }),
      ),
    );
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(a.texto).toContain('Se decidió según un dato de hace 5 d.');
  });

  it('cuando la decisión se tomó contra Meta, el aviso lo dice en lugar de citar una edad', () => {
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          mensaje: null,
          motivo: 'ya_esta_en_ese_estado',
          edadDelDato: 'confirmado contra Meta al resolver el pedido',
        }),
      ),
    );
    expect(a.texto).toContain('Se decidió según un dato confirmado contra Meta al resolver el pedido.');
  });

  it('sin razón conocida, la edad es lo único que el aviso puede aportar y va igual', () => {
    // Es el peor cuerpo: el que producía `HTTP 200`. Que además diga con qué dato
    // se decidió es la diferencia entre "no sé qué pasó" y "se decidió con esto".
    const a = avisoDe(
      200,
      cuerpoCon(resultado({ estado: 'omitido', mensaje: null, edadDelDato: 'sin fecha de sincronización' })),
    );
    expect(a.texto).toContain('omitió el objeto sin llamar a Meta');
    expect(a.texto).toContain('Se decidió según un dato sin fecha de sincronización.');
    expect(a.texto).not.toContain('200');
  });

  it('sin el campo, el aviso queda como antes: una sola oración y sin cola colgada', () => {
    // El campo es opcional y los otros cuatro desenlaces no lo mandan. Una cola
    // vacía («Se decidió según un dato .») sería peor que no decir nada.
    for (const edadDelDato of [undefined, null, '']) {
      const a = avisoDe(
        200,
        cuerpoCon(resultado({ estado: 'omitido', mensaje: null, motivo: 'campo_no_aplica', edadDelDato })),
      );
      expect(a.texto, String(edadDelDato)).toBe(`El cambio no se aplicó porque ${MOTIVO_TEXTO.campo_no_aplica}.`);
    }
  });

  it('sólo la Omisión la nombra: los otros desenlaces no hablan de la copia local', () => {
    // Un `fallido` o un `indeterminado` no se decidieron con un dato viejo: Meta
    // contestó. Colgarles la edad ahí mandaría a buscar un problema de frescura
    // donde hubo un rechazo.
    for (const estado of ['indeterminado', 'fallido', 'no_intentado'] as const) {
      const a = avisoDe(
        200,
        cuerpoCon(resultado({ estado, mensaje: 'Meta rechazó el cambio.', edadDelDato: 'de hace 5 d' })),
      );
      expect(a.texto, estado).not.toContain('de hace 5 d');
    }
  });
});

// ─── La advertencia del Preflight (task 15: R6.4, R3.4) ─────────────────────
//
// El agujero que este bloque cierra: `advertenciaPadreApagado` ya calculaba en el
// servidor que un conjunto activado bajo una campaña pausada no va a entregar, y
// el traductor lo tiraba a la basura. En la auditoría de producción hay tres
// `manual activate` con `estado = confirmado` y `PAUSED → ACTIVE` de objetos que
// igual no entregaron: la escritura ocurrió, la pantalla la confirmó y nadie dijo
// que no servía para nada.
//
// Los textos NO se escriben a mano acá: salen de `advertenciaPadreApagado`, el
// mismo productor que los pone en la respuesta. Si esa frase cambia, estos casos
// siguen valiendo y ninguno queda verificando una cadena que ya nadie manda.
describe('la advertencia de padre apagado y objeto desaparecido (R6.4, R3.4)', () => {
  // `'activate'` explícito: desde la task 12 de `toggle-conjuntos-entrega` el
  // productor tiene dos variantes —`pause` dice lo mismo en pasado— y el
  // traductor tiene que seguir sabiendo qué hacer con la de activar, que es la
  // del caso reportado en la auditoría.
  const ADV_CAMPANIA = advertenciaPadreApagado('adset', { campania: 'PAUSED', conjunto: null }, 'activate')!;
  const ADV_DESAPARECIDO = 'objeto desaparecido: Meta ya no lo devuelve y la escritura puede fallar';

  it('un confirmado con advertencia deja de ser silencio: dice que se aplicó Y que no entrega', () => {
    // El caso reportado como "parece que lo habilita pero realmente no lo hace"
    // con la escritura confirmada. Las dos mitades tienen que estar: sin la
    // primera parece un fallo, sin la segunda es el bug.
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'confirmado', advertencia: ADV_CAMPANIA })));
    expect(a.tono).toBe('aviso'); // ni éxito mudo ni error: se aplicó y no alcanza
    expect(a.texto).toContain('El cambio se aplicó en Meta.');
    expect(a.texto).toContain('no entrega hasta que se active la campaña');
    expect(a.texto).not.toContain('200');
  });

  it('ese aviso viaja marcado como aplicado: es lo que impide revertir la fila', () => {
    // La mitad de la Property 2 que vive en el toggle usa «hay aviso» para
    // revertir el Pintado_Optimista. Este es el único aviso del módulo en el que
    // el cambio SÍ quedó, así que si `aplicado` no viaja, la fila vuelve a PAUSED
    // mientras el texto dice que quedó activa: la contradicción simétrica a la
    // que este spec vino a arreglar.
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'confirmado', advertencia: ADV_CAMPANIA })));
    expect(a.aplicado).toBe(true);
  });

  it('un confirmado sin advertencia sigue siendo null: la regla 1 no se movió', () => {
    for (const advertencia of [undefined, null, '']) {
      expect(
        mensajeDeResultado(200, cuerpoCon(resultado({ estado: 'confirmado', advertencia }))),
        String(advertencia),
      ).toBeNull();
    }
  });

  it('la omisión por «ya está en ese estado» y la advertencia van JUNTAS', () => {
    // 92 de los 169 conjuntos de la cuenta real están ACTIVE bajo una campaña
    // pausada: activarlos se omite Y no entregan. Con uno solo de los dos hechos
    // el aviso explica por qué no se escribió y no por qué el objeto sigue sin
    // hacer nada, que es la pregunta que trajo el reporte.
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          mensaje: null,
          motivo: 'ya_esta_en_ese_estado',
          advertencia: ADV_CAMPANIA,
        }),
      ),
    );
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(a.texto).toContain('no entrega hasta que se active la campaña');
    // Y no se aplicó nada: acá la fila SÍ tiene que volver a su valor previo.
    expect(a.aplicado).toBeUndefined();
  });

  it('el motivo, la edad del dato y la advertencia entran los tres, en ese orden', () => {
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'omitido',
          mensaje: null,
          motivo: 'ya_esta_en_ese_estado',
          edadDelDato: 'de hace 4 min',
          advertencia: ADV_CAMPANIA,
        }),
      ),
    );
    expect(a.texto).toBe(
      `El cambio no se aplicó porque ${MOTIVO_TEXTO.ya_esta_en_ese_estado}. ` +
        'Se decidió según un dato de hace 4 min. ' +
        'La campaña está pausada: el conjunto queda activo pero no entrega hasta que se active la campaña.',
    );
  });

  it('la advertencia se muestra como oración: mayúscula al empezar y punto al cerrar', () => {
    // Llega como cláusula en minúscula porque del otro lado la muestra una celda
    // de tabla. Pegada al texto anterior sin puntuación, los dos hechos se leen
    // como uno solo y el que se venía escondiendo se sigue escondiendo.
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'confirmado', advertencia: ADV_CAMPANIA })));
    expect(ADV_CAMPANIA.startsWith('la campaña')).toBe(true);
    expect(a.texto).toContain('. La campaña está pausada');
    expect(a.texto.endsWith('.')).toBe(true);
  });

  it('las dos advertencias juntas llegan las dos, con el separador del servidor', () => {
    // `sumarAdvertencia` las une con ` · ` cuando el objeto está desaparecido Y
    // tiene el padre apagado. El traductor no reescribe eso: lo muestra.
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({ estado: 'confirmado', advertencia: `${ADV_CAMPANIA} · ${ADV_DESAPARECIDO}` }),
      ),
    );
    expect(a.texto).toContain('no entrega hasta que se active la campaña');
    expect(a.texto).toContain(' · objeto desaparecido');
  });

  it('un fallido con advertencia conserva el tono de error y suma la explicación probable', () => {
    // Un rechazo de Meta sobre un objeto que la base todavía tiene: la
    // desaparición es la explicación más probable del rechazo, así que sumarla no
    // es ruido. El tono no baja a advertencia: algo falló de verdad.
    const a = avisoDe(
      200,
      cuerpoCon(
        resultado({
          estado: 'fallido',
          mensaje: 'Meta rechazó el cambio.',
          advertencia: ADV_DESAPARECIDO,
        }),
      ),
    );
    expect(a.tono).toBe('error');
    expect(a.texto).toContain('Meta rechazó el cambio.');
    expect(a.texto).toContain('Objeto desaparecido');
    expect(a.aplicado).toBeUndefined();
  });

  it('un indeterminado con advertencia también la lleva', () => {
    const a = avisoDe(
      200,
      cuerpoCon(resultado({ estado: 'indeterminado', mensaje: null, advertencia: ADV_CAMPANIA })),
    );
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain('No se sabe si el cambio se aplicó');
    expect(a.texto).toContain('no entrega hasta que se active la campaña');
  });

  it('sólo el confirmado se marca como aplicado: los otros cuatro desenlaces no', () => {
    // La invariante que protege la reversión del toggle, verificada sobre los
    // cinco estados y no sobre el que se acaba de tocar.
    for (const estado of ['omitido', 'indeterminado', 'fallido', 'no_intentado'] as const) {
      const a = avisoDe(
        200,
        cuerpoCon(resultado({ estado, mensaje: 'Meta rechazó el cambio.', advertencia: ADV_CAMPANIA })),
      );
      expect(a.aplicado, estado).not.toBe(true);
    }
  });

  it('el aviso del lote de UN objeto también la lleva: el toggle y el lote dicen lo mismo', () => {
    const c = cuerpoCon(resultado({ estado: 'confirmado', advertencia: ADV_CAMPANIA }));
    expect(avisoDeLote(200, c)).toEqual(mensajeDeResultado(200, c));
    expect(avisoLoteDe(200, c).texto).toContain('no entrega hasta que se active la campaña');
  });
});

describe('regla 3: indeterminado no es éxito ni fallo (R2 c7)', () => {
  it('dice que no se sabe si el cambio se aplicó y nombra la reconciliación', () => {
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'indeterminado', mensaje: null })));
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain('No se sabe si el cambio se aplicó');
    expect(a.texto).toContain('reconciliación');
  });
});

describe('regla 4: fallido usa el mensaje del catálogo de errores', () => {
  it('con mensaje, lo muestra tal cual y con tono de error', () => {
    const delCatalogo =
      'Falta el pagador del DSA en la cuenta. Meta lo exige para copiar conjuntos que segmentan la Unión Europea.';
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'fallido', mensaje: delCatalogo })));
    expect(a.tono).toBe('error');
    expect(a.texto).toBe(delCatalogo);
  });

  it('sin mensaje, dice que Meta rechazó sin informar el motivo y que el objeto quedó como estaba', () => {
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'fallido', mensaje: null })));
    expect(a.tono).toBe('error');
    expect(a.texto).toContain('Meta rechazó el cambio');
    expect(a.texto).toContain('quedó como estaba');
    expect(a.texto).not.toContain('200');
  });
});

describe('el quinto estado: no_intentado', () => {
  it('un lote cortado antes de llegar al objeto lo dice, en lugar de mostrar el código', () => {
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'no_intentado', mensaje: null })));
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain('no se intentó');
    expect(a.texto).not.toContain('200');
  });
});

describe('regla 5: el cuerpo de un rechazo usa detail y si no error (R2 c5)', () => {
  it('400 con invalid_payload y detail Required muestra el detail: es el bug del presupuesto', () => {
    // El cuerpo exacto que devuelve el route cuando zod rechaza el payload
    // (`detail: parsed.error.issues[0]?.message`). Con `budgetEur: undefined`
    // ese mensaje era `Required`, y la barra de lote no lo mostraba. El texto
    // deja de ser genérico cuando la task 3.3 le pone mensajes al schema; lo que
    // este caso fija es que el detail LLEGA a pantalla (R1 c6).
    const a = avisoDe(400, { ok: false, error: 'invalid_payload', detail: 'Required' });
    expect(a.tono).toBe('error');
    expect(a.texto).toBe('Required');
    expect(a.texto).not.toContain('400');
  });

  it('400 con sólo error, sin detail, muestra el error', () => {
    const a = avisoDe(400, { ok: false, error: 'nivel_no_coincide' });
    expect(a.tono).toBe('error');
    expect(a.texto).toBe('nivel_no_coincide');
  });

  it('401 sin cookie muestra unauthorized', () => {
    const a = avisoDe(401, { ok: false, error: 'unauthorized' });
    expect(a.tono).toBe('error');
    expect(a.texto).toBe('unauthorized');
  });

  it('un detail vacío no gana: cae al error', () => {
    const a = avisoDe(400, { ok: false, error: 'fecha_invalida', detail: '' });
    expect(a.texto).toBe('fecha_invalida');
  });

  it('el resultado le gana al cuerpo: un 400 con resultados adentro se explica por el resultado', () => {
    // No lo produce el route de hoy, pero el orden de las reglas lo decide y el
    // resultado es más específico que el error del sobre.
    const c = {
      ...(cuerpoCon(resultado({ estado: 'fallido', mensaje: 'Meta rechazó el cambio.' })) as object),
      ok: false,
      error: 'invalid_payload',
      detail: 'Required',
    } as unknown as CuerpoAcciones;
    expect(avisoDe(400, c).texto).toBe('Meta rechazó el cambio.');
  });
});

describe('regla 6: el código, y sólo cuando el status no es 2xx', () => {
  it('un 500 con cuerpo inservible nombra el código', () => {
    for (const cuerpo of [
      null,
      undefined,
      {} as CuerpoAcciones,
      '<html><body>Bad Gateway</body></html>' as unknown as CuerpoAcciones,
      { ok: false } as CuerpoAcciones,
      { ok: false, error: null, detail: null } as CuerpoAcciones,
    ]) {
      const a = avisoDe(500, cuerpo);
      expect(a.tono, `tono con ${JSON.stringify(cuerpo)}`).toBe('error');
      expect(a.texto, `texto con ${JSON.stringify(cuerpo)}`).toContain('500');
    }
  });

  it('un 2xx con cuerpo inservible dice que no hubo desenlace, SIN el código', () => {
    for (const cuerpo of [
      null,
      undefined,
      {} as CuerpoAcciones,
      '<html><body>OK</body></html>' as unknown as CuerpoAcciones,
      cuerpoCon(), // `resultados: []`
      { ok: true, aplicados: 0, total: 0, corte: null, resultados: 'nope' } as unknown as CuerpoAcciones,
      { ok: true, aplicados: 0, total: 1, corte: null, resultados: [null] } as unknown as CuerpoAcciones,
    ]) {
      const a = avisoDe(204, cuerpo);
      expect(a.tono, `tono con ${JSON.stringify(cuerpo)}`).toBe('aviso');
      expect(a.texto, `texto con ${JSON.stringify(cuerpo)}`).toContain('sin informar el desenlace');
      expect(a.texto, `texto con ${JSON.stringify(cuerpo)}`).not.toContain('204');
    }
  });

  it('nunca tira, ni con un cuerpo que no tiene nada que ver', () => {
    // El cuerpo entra de un `res.json()`: un proxy puede devolver cualquier cosa.
    for (const cuerpo of [0, false, [], [1, 2, 3], 'texto suelto', { resultados: {} }]) {
      expect(() => mensajeDeResultado(502, cuerpo as unknown as CuerpoAcciones)).not.toThrow();
      expect(() => mensajeDeResultado(200, cuerpo as unknown as CuerpoAcciones)).not.toThrow();
    }
  });
});

// ─── El aviso de una Accion_Lote (task 4.2) ─────────────────────────────────
//
// `avisoDeLote` existe porque los dos llamadores no ven lo mismo: el toggle manda
// un objeto y `resultados[0]` ES su objeto, mientras que un lote manda hasta 100
// y `resultados[0]` no habla por los otros 99. Lo que estos casos fijan es dónde
// está la frontera: cuándo el lote dice letra por letra lo mismo que el toggle
// (R2 c5) y cuándo se calla y deja hablar al desglose de `ResultadosLote`.

/** Como `avisoDe`, para el aviso del lote. */
function avisoLoteDe(httpStatus: number, cuerpo: CuerpoAcciones | null | undefined): Aviso {
  const a = avisoDeLote(httpStatus, cuerpo);
  if (a === null) throw new Error('se esperaba un aviso del lote y devolvió null');
  expect(a.texto.length, 'un aviso sin texto es un éxito silencioso').toBeGreaterThan(0);
  return a;
}

describe('avisoDeLote regla 1: el sobre se traduce igual que en el toggle (R2 c5)', () => {
  it('los rechazos del servidor dan EXACTAMENTE el aviso del toggle', () => {
    // Es la garantía que pide la task: ante la misma respuesta, las dos pantallas
    // no pueden decir cosas distintas. Se compara contra `mensajeDeResultado`, no
    // contra un literal, así que un cambio en el criterio los mueve a los dos.
    const sobres: readonly (readonly [number, CuerpoAcciones | null])[] = [
      [400, { ok: false, error: 'invalid_payload', detail: 'falta el presupuesto en euros (budgetEur)' }],
      [400, { ok: false, error: 'nivel_no_coincide' }],
      [400, { ok: false, error: 'fecha_invalida', detail: '' }],
      [401, { ok: false, error: 'unauthorized' }],
      [500, null],
      [502, { ok: false } as CuerpoAcciones],
    ];
    for (const [status, cuerpo] of sobres) {
      expect(avisoDeLote(status, cuerpo), `sobre ${status}`).toEqual(
        mensajeDeResultado(status, cuerpo),
      );
    }
  });

  it('el HTTP ${status} propio del lote ya no existe: un 400 con detail muestra el detail', () => {
    const a = avisoLoteDe(400, { ok: false, error: 'invalid_payload', detail: 'Required' });
    expect(a.tono).toBe('error');
    expect(a.texto).toBe('Required');
    expect(a.texto).not.toContain('400');
  });

  it('un cuerpo ilegible bajo un 200 no se lee como éxito', () => {
    // El caso del proxy que devuelve HTML: antes `res.json()` tiraba y el catch
    // mostraba "El lote no respondió a tiempo: Unexpected token <".
    const a = avisoLoteDe(200, null);
    expect(a.texto.length).toBeGreaterThan(0);
    expect(a.texto).not.toContain('200');
  });

  it('un sobre que se contradice —no procesado, con un confirmado adentro— igual dice algo', () => {
    const c = {
      ...(cuerpoCon(resultado({ estado: 'confirmado' })) as object),
      ok: false,
    } as unknown as CuerpoAcciones;
    // `mensajeDeResultado` devuelve null acá (regla 1: confirmado no dice nada).
    expect(mensajeDeResultado(400, c)).toBeNull();
    const a = avisoLoteDe(400, c);
    expect(a.tono).toBe('error');
    expect(a.texto).toContain('no procesó el lote');
  });
});

describe('avisoDeLote regla 2: un lote de un objeto es un toggle con otro botón', () => {
  it('con un solo resultado, el aviso es idéntico al del toggle', () => {
    const unicos: readonly CuerpoAcciones[] = [
      cuerpoCon(resultado({ estado: 'confirmado' })),
      cuerpoCon(resultado({ estado: 'omitido', mensaje: null, motivo: 'ya_esta_en_ese_estado' })),
      cuerpoCon(resultado({ estado: 'indeterminado', mensaje: null })),
      cuerpoCon(resultado({ estado: 'fallido', mensaje: 'Meta rechazó el cambio.' })),
      cuerpoCon(resultado({ estado: 'no_intentado', mensaje: null })),
    ];
    for (const c of unicos) {
      expect(avisoDeLote(200, c), JSON.stringify(c)).toEqual(mensajeDeResultado(200, c));
    }
  });

  it('la omisión de un lote de uno nombra el motivo, no un conteo', () => {
    const a = avisoLoteDe(
      200,
      cuerpoCon(resultado({ estado: 'omitido', mensaje: null, motivo: 'ya_esta_en_ese_estado' })),
    );
    expect(a.tono).toBe('aviso');
    expect(a.texto).toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
    expect(a.texto).not.toContain('Ninguno de los');
  });
});

describe('avisoDeLote regla 3: con algo aplicado, el desglose alcanza', () => {
  it('devuelve null cuando al menos un objeto se confirmó, aunque otros no', () => {
    // `ResultadosLote` abre con "X de Y aplicados" y lista los no confirmados.
    // Un aviso arriba repitiendo eso con otras palabras es la forma más rápida de
    // que dos partes de la pantalla se contradigan.
    expect(
      avisoDeLote(
        200,
        cuerpoCon(
          resultado({ estado: 'confirmado' }),
          resultado({ estado: 'fallido', mensaje: 'Meta rechazó el cambio.' }),
          resultado({ estado: 'omitido', motivo: 'ya_esta_en_ese_estado' }),
        ),
      ),
    ).toBeNull();
  });

  it('el confirmado cuenta esté donde esté, no sólo en el primer lugar', () => {
    expect(
      avisoDeLote(
        200,
        cuerpoCon(
          resultado({ estado: 'omitido', motivo: 'ya_esta_en_ese_estado' }),
          resultado({ estado: 'confirmado' }),
        ),
      ),
    ).toBeNull();
  });
});

describe('avisoDeLote regla 4: un lote en el que nada cambió lo dice', () => {
  it('cinco omitidos se resumen contados, sin hablar del primero como si fueran todos', () => {
    // El caso que hoy se lee como un éxito: el diálogo se cierra, la selección se
    // limpia y arriba no dice nada, aunque el servidor no haya tocado un objeto.
    const c = cuerpoCon(
      ...Array.from({ length: 5 }, (_, i) =>
        resultado({ objectId: `id-${i}`, estado: 'omitido', motivo: 'ya_esta_en_ese_estado' }),
      ),
    );
    const a = avisoLoteDe(200, c);
    expect(a.tono).toBe('aviso'); // nada falló: no hay nada roto que ir a buscar
    expect(a.texto).toContain('Ninguno de los 5 objetos cambió');
    expect(a.texto).toContain('5 se omitieron');
    expect(a.texto).toContain('lista de resultados');
    // Lo que NO puede hacer: contar el motivo del primero como si valiera para
    // los cinco. El motivo por objeto lo muestra `ResultadosLote`.
    expect(a.texto).not.toContain(MOTIVO_TEXTO.ya_esta_en_ese_estado);
  });

  it('mezcla de desenlaces: cada uno con su conteo y su conjugación', () => {
    const a = avisoLoteDe(
      200,
      cuerpoCon(
        resultado({ objectId: 'a', estado: 'omitido', motivo: 'ya_esta_en_ese_estado' }),
        resultado({ objectId: 'b', estado: 'omitido', motivo: 'campo_no_aplica' }),
        resultado({ objectId: 'c', estado: 'fallido', mensaje: 'Meta rechazó el cambio.' }),
        resultado({ objectId: 'd', estado: 'indeterminado' }),
        resultado({ objectId: 'e', estado: 'no_intentado' }),
      ),
    );
    expect(a.tono).toBe('error'); // hay un fallo real en Meta
    expect(a.texto).toBe(
      'Ninguno de los 5 objetos cambió: 1 falló, 2 se omitieron, ' +
        '1 quedó sin confirmar, 1 no se intentó. ' +
        'El detalle por objeto está en la lista de resultados.',
    );
  });

  it('un solo fallido entre omitidos alcanza para el tono de error', () => {
    const a = avisoLoteDe(
      200,
      cuerpoCon(
        resultado({ objectId: 'a', estado: 'omitido', motivo: 'ya_esta_en_ese_estado' }),
        resultado({ objectId: 'b', estado: 'fallido', mensaje: null }),
      ),
    );
    expect(a.tono).toBe('error');
  });

  it('sin fallidos el tono es advertencia, no error', () => {
    for (const estado of ['omitido', 'indeterminado', 'no_intentado'] as const) {
      const a = avisoLoteDe(
        200,
        cuerpoCon(resultado({ objectId: 'a', estado }), resultado({ objectId: 'b', estado })),
      );
      expect(a.tono, `tono de dos ${estado}`).toBe('aviso');
    }
  });

  it('un desenlace que este cliente no conoce igual produce un aviso, no silencio', () => {
    const a = avisoLoteDe(
      200,
      cuerpoCon(
        resultado({ objectId: 'a', estado: 'flamante' as EstadoResultadoAccion }),
        resultado({ objectId: 'b', estado: 'flamante' as EstadoResultadoAccion }),
      ),
    );
    expect(a.texto).toContain('Ninguno de los 2 objetos cambió');
  });

  it('el conteo sale de resultados, no de aplicados: el texto describe la lista que se dibuja al lado', () => {
    // Un `aplicados` que no coincide con la lista es un bug del servidor. El aviso
    // y el desglose tienen que describir la MISMA lista, así que el conteo se
    // cuenta.
    const c = {
      ok: true,
      aplicados: 3,
      total: 2,
      corte: null,
      resultados: [
        resultado({ objectId: 'a', estado: 'omitido', motivo: 'campo_no_aplica' }),
        resultado({ objectId: 'b', estado: 'omitido', motivo: 'campo_no_aplica' }),
      ],
    } as CuerpoAcciones;
    expect(avisoLoteDe(200, c).texto).toContain('Ninguno de los 2 objetos cambió: 2 se omitieron');
  });

  it('nunca tira, ni con resultados que no son objetos', () => {
    for (const cuerpo of [
      { ok: true, aplicados: 0, total: 2, corte: null, resultados: [null, null] },
      { ok: true, aplicados: 0, total: 2, corte: null, resultados: 'nope' },
      { ok: true, resultados: [1, 2, 3] },
      { ok: true },
    ]) {
      expect(() => avisoDeLote(200, cuerpo as unknown as CuerpoAcciones)).not.toThrow();
    }
  });
});

describe('el límite honesto de la garantía', () => {
  it('un mensaje del servidor que menciona 200 se muestra tal cual bajo un status 200', () => {
    // La garantía es que el módulo no FABRICA texto con el status, no que el
    // dígito no pueda aparecer: 200 es el techo de presupuesto por defecto, así
    // que un mensaje del servidor lo nombra con toda legitimidad. Censurarlo
    // sería esconder el dato que el usuario necesita.
    const delServidor = 'el importe supera el techo configurado de 200 EUR';
    const a = avisoDe(200, cuerpoCon(resultado({ estado: 'fallido', mensaje: delServidor })));
    expect(a.texto).toBe(delServidor);
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────
// Locales a este archivo: son cuerpos de una respuesta HTTP, no objetos del
// dominio, y no los comparte nadie más.
//
// Todo el texto que estos generadores meten en el cuerpo está LIBRE de cualquier
// tramo `2\d\d`, y el test de abajo lo verifica en lugar de confiar en la
// inspección visual. Es lo que hace concluyente a la Property 3: si el aviso de
// un status 2xx contiene ese status, el texto no pudo venir del cuerpo.
//
// Sin esta restricción la propiedad sería inestable y no más fuerte: las reglas
// 4 y 5 devuelven texto que el SERVIDOR escribió (el catálogo de errores
// interpola el objectId y los segundos de backoff; `detail` viene de zod), y un
// mensaje de presupuesto que dijera "200 EUR" la haría fallar sin que el módulo
// haya hecho nada mal. Ese caso queda cubierto arriba, como caso puntual.

/**
 * Mensajes con la forma de los que manda el servidor: cinco del catálogo de
 * errores, uno del Preflight y el `Required` de zod. Elegidos sin dígitos, por
 * el motivo de arriba.
 */
const MENSAJES_DEL_SERVIDOR = [
  'Meta rechazó el cambio y no informó un motivo reconocible.',
  'El token de acceso venció o dejó de ser válido. Hay que renovarlo.',
  'Meta cortó por cuota de la API: el lote se detuvo y no hay reintento automático.',
  'Falta el pagador del DSA en la cuenta.',
  'La cuenta alcanzó su máximo de objetos en el nivel conjunto.',
  'no se pudo resolver el inicio en la zona de la cuenta',
  'Required',
] as const;

/**
 * Las advertencias del Preflight, tal como las arma `previsualizacion.ts`: las
 * tres del padre apagado, la del objeto desaparecido SIN fecha y las dos juntas
 * con el ` · ` de `sumarAdvertencia`.
 *
 * La variante con fecha queda afuera de los generadores a propósito: el año la
 * mete un tramo `20\d\d` y con eso la Property 3 dejaría de ser concluyente (ver
 * el comentario de arriba). Que la fecha se muestre bien es un caso puntual del
 * bloque de la task 15, no una propiedad.
 */
const ADVERTENCIAS = [
  advertenciaPadreApagado('adset', { campania: 'PAUSED', conjunto: null }, 'activate')!,
  advertenciaPadreApagado('ad', { campania: 'ACTIVE', conjunto: 'PAUSED' }, 'activate')!,
  advertenciaPadreApagado('ad', { campania: 'PAUSED', conjunto: 'PAUSED' }, 'activate')!,
  'objeto desaparecido: Meta ya no lo devuelve y la escritura puede fallar',
  `${advertenciaPadreApagado('adset', { campania: 'PAUSED', conjunto: null }, 'activate')!} · objeto desaparecido: Meta ya no lo devuelve y la escritura puede fallar`,
] as const;

/** Ids con forma de id de Meta y sin el dígito 2, así ningún tramo suyo puede ser un 2xx. */
const IDS = ['613487905136', '987654310445', '170088341955'] as const;

const NOMBRES = ['Conjunto frío EUR', 'Campaña de retargeting', 'Anuncio vertical'] as const;

const CODIGOS_DE_ERROR = ['invalid_payload', 'unauthorized', 'nivel_no_coincide', 'fecha_invalida'] as const;

const CUERPOS_INSERVIBLES = [
  null,
  undefined,
  {} as CuerpoAcciones,
  '<html><body>Bad Gateway</body></html>' as unknown as CuerpoAcciones,
  [] as unknown as CuerpoAcciones,
  { resultados: 'nope' } as unknown as CuerpoAcciones,
  { ok: true, aplicados: 0, total: 0, corte: null, resultados: [] } as CuerpoAcciones,
] as const;

const ESTADOS: readonly EstadoResultadoAccion[] = [
  'confirmado',
  'omitido',
  'indeterminado',
  'fallido',
  'no_intentado',
];

const genResultado: fc.Arbitrary<ResultadoAccion> = fc.record({
  objectId: fc.constantFrom(...IDS),
  objectName: fc.option(fc.constantFrom(...NOMBRES), { nil: null }),
  estado: fc.constantFrom(...ESTADOS),
  // El `''` está adentro a propósito: es el borde entre "el servidor mandó un
  // mensaje" y "no mandó nada". `textoDeOmision` y `textoDeError` lo tratan como
  // ausente; la regla 4 no, y de ahí sale el contraejemplo de la Property 2.
  //
  // Los `freq: 2` no son estéticos: `omitido` sin motivo NI mensaje es la
  // conjunción de tres elecciones, y con la frecuencia por defecto de `fc.option`
  // (1/5 de nil) esa rama caía a un puñado de casos por corrida, lo bastante
  // cerca de cero para que la verificación de cobertura de abajo se volviera
  // inestable. Con nil a la mitad quedan ~18 casos en 600 corridas.
  mensaje: fc.option(fc.constantFrom(...MENSAJES_DEL_SERVIDOR, ''), { nil: null, freq: 2 }),
  codigoMeta: fc.option(fc.constantFrom(100, 190, 613, 2, 17), { nil: null, freq: 3 }),
  motivo: fc.option(fc.constantFrom(...MOTIVOS), { nil: undefined, freq: 2 }),
  // La advertencia de la task 15, en los CINCO desenlaces y no sólo en los tres
  // que hoy la mandan: las dos propiedades tienen que valer para un servidor que
  // mañana la agregue en otra rama. El `''` cuenta como ausente, igual que en
  // `mensaje`, y por eso está.
  advertencia: fc.option(fc.constantFrom(...ADVERTENCIAS, ''), { nil: null, freq: 3 }),
});

const genCuerpoOk: fc.Arbitrary<CuerpoAcciones> = fc.record({
  ok: fc.constant<true>(true),
  aplicados: fc.nat({ max: 5 }),
  total: fc.nat({ max: 5 }),
  corte: fc.constant(null),
  resultados: fc.array(genResultado, { minLength: 1, maxLength: 3 }),
});

const genCuerpoRechazo: fc.Arbitrary<CuerpoAcciones> = fc.record({
  ok: fc.constant<false>(false),
  error: fc.option(fc.constantFrom(...CODIGOS_DE_ERROR), { nil: null, freq: 4 }),
  detail: fc.option(fc.constantFrom(...MENSAJES_DEL_SERVIDOR), { nil: null, freq: 3 }),
});

const genCuerpo: fc.Arbitrary<CuerpoAcciones | null | undefined> = fc.oneof(
  { weight: 6, arbitrary: genCuerpoOk },
  { weight: 3, arbitrary: genCuerpoRechazo },
  { weight: 2, arbitrary: fc.constantFrom(...CUERPOS_INSERVIBLES) },
);

/** Todo status que el fetch puede considerar exitoso. */
const statusExitoso: fc.Arbitrary<number> = fc.integer({ min: 200, max: 299 });

/** Un tramo de tres dígitos que empieza en 2: la forma de todo status 2xx. */
const TRAMO_2XX = /2\d\d/;

/**
 * La rama que un cuerpo hace tomar, derivada del cuerpo y no de la salida. Se
 * usa para medir la cobertura de la propiedad: sin esto, un generador que
 * degenerara a puros cuerpos inservibles la dejaría verde sin haber pasado
 * nunca por las reglas 1 a 5.
 */
function ramaDe(cuerpo: CuerpoAcciones | null | undefined): string {
  const rs = (cuerpo as { resultados?: unknown } | null | undefined)?.resultados;
  const r = Array.isArray(rs) && rs.length > 0 && typeof rs[0] === 'object' && rs[0] !== null
    ? (rs[0] as ResultadoAccion)
    : null;
  if (r !== null) {
    const sinRazon = r.motivo === undefined && (r.mensaje === null || r.mensaje === '');
    if (r.estado === 'omitido') return sinRazon ? 'omitido_sin_razon' : 'omitido_con_razon';
    if (r.estado === 'fallido') return r.mensaje ? 'fallido_con_mensaje' : 'fallido_sin_mensaje';
    return r.estado;
  }
  const c = cuerpo as { ok?: unknown; error?: unknown; detail?: unknown } | null | undefined;
  if (c?.ok === false && (c.error || c.detail)) return 'rechazo_con_texto';
  return 'sin_desenlace';
}

const RAMAS_ESPERADAS = [
  'confirmado',
  'omitido_con_razon',
  'omitido_sin_razon',
  'indeterminado',
  'fallido_con_mensaje',
  'fallido_sin_mensaje',
  'no_intentado',
  'rechazo_con_texto',
  'sin_desenlace',
] as const;

// Feature: frescura-y-acciones-anuncios, Property 3: El mensaje nunca es un
// código de éxito
//
// **Validates: Requirements 2.6**
//
// Para toda respuesta con status HTTP en 2xx, el texto del aviso no contiene la
// representación decimal de ese status. Un `200` no puede producir el texto
// `HTTP 200`.
//
// Dos mitades, porque una sola no alcanza:
//
// - La primera es la propiedad literal del design. Es concluyente porque el
//   generador garantiza que ningún texto del cuerpo tiene un tramo `2\d\d`
//   (el test de abajo lo verifica), así que un tramo así en la salida sólo pudo
//   fabricarlo el módulo a partir del status.
// - La segunda ataca lo mismo sin depender de los dígitos del cuerpo: dentro de
//   2xx, la salida no cambia si cambia el status. Un texto que no depende del
//   status no puede derivarse de él, y esta mitad vale también para los cuerpos
//   que sí traen números del servidor.
describe('Property 3 (R2 c6)', () => {
  it('los generadores no meten ningún tramo 2xx en el cuerpo, así un match sólo puede venir del status', () => {
    const textos: readonly string[] = [
      ...MENSAJES_DEL_SERVIDOR,
      ...IDS,
      ...NOMBRES,
      ...CODIGOS_DE_ERROR,
      ...ADVERTENCIAS,
      ...Object.values(MOTIVO_TEXTO),
      ...CUERPOS_INSERVIBLES.map((c) => JSON.stringify(c) ?? ''),
    ];
    for (const t of textos) {
      expect(TRAMO_2XX.test(t), `texto del generador con tramo 2xx: ${JSON.stringify(t)}`).toBe(false);
    }
  });

  it('para todo status 2xx y todo cuerpo, el texto no contiene el código', () => {
    const ramas = new Map<string, number>();

    fc.assert(
      fc.property(statusExitoso, genCuerpo, (httpStatus, cuerpo) => {
        ramas.set(ramaDe(cuerpo), (ramas.get(ramaDe(cuerpo)) ?? 0) + 1);
        const a = mensajeDeResultado(httpStatus, cuerpo);
        if (a === null) return; // confirmado: no hay texto donde el código pueda estar
        expect(a.texto, `status ${httpStatus} con cuerpo ${JSON.stringify(cuerpo)}`).not.toContain(
          String(httpStatus),
        );
        // Ni el código ni la etiqueta con la que se mostraba.
        expect(a.texto).not.toContain('HTTP');
      }),
      { numRuns: 600 },
    );

    // La propiedad no es vacua: las nueve ramas se recorrieron de verdad. Con la
    // mezcla de arriba, una corrida de 600 reparte del orden de 60 confirmado,
    // 36 omitido con razón, 25 sin razón, 70 indeterminado, 28 fallido con
    // mensaje, 36 sin mensaje, 66 no_intentado, 145 rechazo y 125 sin desenlace.
    for (const rama of RAMAS_ESPERADAS) {
      const detalle = JSON.stringify(Object.fromEntries(ramas));
      expect(ramas.get(rama) ?? 0, `rama ${rama} nunca generada; ramas: ${detalle}`).toBeGreaterThan(0);
    }
  });

  it('el aviso del lote tampoco contiene el código, ni por el conteo de objetos', () => {
    // `avisoDeLote` es el segundo productor de texto del módulo desde la task 4.2,
    // así que la garantía tiene que valer para él o R2 c6 queda cubierta a medias.
    // El resumen interpola un conteo, que es el único número que este módulo saca
    // de la respuesta: en producción no puede pasar de 100 (el tope de objetos por
    // Accion_Lote), así que no hay conteo que pueda escribirse como un 2xx.
    fc.assert(
      fc.property(statusExitoso, genCuerpo, (httpStatus, cuerpo) => {
        const a = avisoDeLote(httpStatus, cuerpo);
        if (a === null) return;
        expect(a.texto, `status ${httpStatus} con cuerpo ${JSON.stringify(cuerpo)}`).not.toContain(
          String(httpStatus),
        );
        expect(a.texto).not.toContain('HTTP');
      }),
      { numRuns: 600 },
    );
  });

  it('dentro de 2xx el aviso no depende de cuál 2xx sea, ni con cuerpos que traen números', () => {
    // Acá los mensajes del servidor SÍ llevan dígitos, incluido un 200: es el
    // caso que la primera mitad no puede cubrir sin volverse inestable.
    const conNumeros = fc.constantFrom(
      'Meta cortó por cuota. Volvé a intentar en 200 segundos.',
      'el importe supera el techo configurado de 200 EUR',
      'Meta rechazó la operación sobre «Conjunto» (120200099887).',
      'la cuenta llegó a su tope de 250 objetos',
    );
    const genConNumeros: fc.Arbitrary<CuerpoAcciones | null | undefined> = fc.oneof(
      genCuerpo,
      fc.record({
        ok: fc.constant<true>(true),
        aplicados: fc.constant(0),
        total: fc.constant(1),
        corte: fc.constant(null),
        resultados: fc.tuple(
          fc.record({
            objectId: fc.constantFrom(...IDS),
            objectName: fc.constant(null),
            estado: fc.constantFrom<EstadoResultadoAccion>('fallido', 'omitido', 'indeterminado'),
            mensaje: conNumeros,
            codigoMeta: fc.constant(null),
          }),
        ),
      }),
      fc.record({
        ok: fc.constant<false>(false),
        error: fc.constant('invalid_payload'),
        detail: conNumeros,
      }),
    );

    fc.assert(
      fc.property(statusExitoso, statusExitoso, genConNumeros, (a, b, cuerpo) => {
        expect(mensajeDeResultado(a, cuerpo)).toEqual(mensajeDeResultado(b, cuerpo));
      }),
      { numRuns: 400 },
    );
  });
});

// Feature: frescura-y-acciones-anuncios, Property 2: No hay éxito silencioso
//
// **Validates: Requirements 2.3, 2.6**
//
// La mitad de la Property 2 que vive en este módulo: para toda respuesta cuyo
// primer resultado no sea `confirmado`, se muestra un aviso NO VACÍO. (La otra
// mitad —que la fila vuelve a su valor previo— vive en `toggleEstado` y se
// verifica en la task 4.3.)
//
// Va en un `describe` propio y no adentro de la Property 3 porque son dos
// invariantes distintas: un texto vacío no contiene ningún código de status, así
// que la Property 3 se cumple igual y mezclarlas atribuiría el fallo a la regla
// equivocada.
//
// La invariante que protege: si el traductor devuelve un aviso, ese aviso tiene
// texto, para CUALQUIER cuerpo que el servidor pueda mandar. Un `{ tono: 'error',
// texto: '' }` es un éxito silencioso: la pantalla no puede pintar un aviso en
// blanco, así que el usuario ve la fila revertida sin una sola palabra sobre por
// qué el cambio no se aplicó — el mismo agujero que el `HTTP 200`, por el otro
// extremo. Es también lo que el tipo `Aviso` promete en su comentario ("Nunca
// vacío"), y un tipo no puede hacer cumplir eso solo.
//
// El contraejemplo que esta propiedad encontró cuando se escribió: la regla 4
// hacía `r.mensaje ?? TEXTO_FALLIDO_SIN_MENSAJE`, y `??` sólo cubre `null` y
// `undefined`, así que un `mensaje: ''` pasaba derecho. Las reglas 2 y 5 ya
// trataban `''` como ausente y la 4 se lo había olvidado; ahora las tres
// normalizan con el mismo `textoONulo` de `mensajes.ts`, que es lo que impide
// que la inconsistencia vuelva por una cuarta rama. Por eso el generador de
// `mensaje` mantiene el `''` entre sus valores: sin ese caso, la propiedad no
// vigila nada.
describe('Property 2 (R2 c3, c6)', () => {
  it('para todo status 2xx y todo cuerpo, un desenlace distinto de confirmado deja un aviso no vacío', () => {
    fc.assert(
      fc.property(statusExitoso, genCuerpo, (httpStatus, cuerpo) => {
        const a = mensajeDeResultado(httpStatus, cuerpo);
        if (a === null) {
          // Un aviso ausente sólo se admite cuando el objeto se confirmó: es la
          // regla 1. En cualquier otro caso sería un cambio no aplicado del que
          // la pantalla no dice nada.
          expect(ramaDe(cuerpo)).toBe('confirmado');
          return;
        }
        expect(
          a.texto.length,
          `aviso vacío con status ${httpStatus} y cuerpo ${JSON.stringify(cuerpo)}`,
        ).toBeGreaterThan(0);
        // La otra cara de la misma invariante, desde que existe la advertencia de
        // la task 15: el aviso que dice «esto sí se aplicó» sólo puede salir de un
        // `confirmado`. Si saliera de cualquier otro desenlace, el toggle dejaría
        // la fila cambiada sin que Meta haya confirmado nada — el éxito silencioso
        // por el otro extremo.
        if (a.aplicado === true) {
          expect(ramaDe(cuerpo), `aplicado con cuerpo ${JSON.stringify(cuerpo)}`).toBe('confirmado');
        }
      }),
      { numRuns: 600 },
    );
  });

  // La versión de la misma invariante para el lote. El silencio de `avisoDeLote`
  // significa otra cosa que el de `mensajeDeResultado` —"el desglose de
  // `ResultadosLote` ya lo cuenta", no "salió todo bien"— pero la condición que
  // lo habilita es la misma: algo se aplicó. Un lote en el que el servidor no
  // tocó un solo objeto siempre deja texto en pantalla.
  it('el lote sólo se calla cuando algún objeto se confirmó, y si habla no habla en blanco', () => {
    fc.assert(
      fc.property(statusExitoso, genCuerpo, (httpStatus, cuerpo) => {
        const a = avisoDeLote(httpStatus, cuerpo);
        if (a === null) {
          const rs = (cuerpo as { resultados?: unknown } | null | undefined)?.resultados;
          const confirmados = Array.isArray(rs)
            ? rs.filter((r) => (r as ResultadoAccion | null)?.estado === 'confirmado').length
            : 0;
          expect(
            confirmados,
            `lote sin aviso y sin nada aplicado: ${JSON.stringify(cuerpo)}`,
          ).toBeGreaterThan(0);
          return;
        }
        expect(
          a.texto.length,
          `aviso de lote vacío con status ${httpStatus} y cuerpo ${JSON.stringify(cuerpo)}`,
        ).toBeGreaterThan(0);
      }),
      { numRuns: 600 },
    );
  });
});
