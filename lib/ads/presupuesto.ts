/**
 * La regla de validez de un presupuesto diario (task 1.1 de
 * frescura-y-acciones-anuncios). PURA: sin `pg`, sin red y sin React, porque la
 * tienen que compartir los tres lugares donde hoy vive escrita tres veces: el
 * `valido` de `FormularioPresupuesto`, la edición de celda de `celdas.tsx` y el
 * schema de `budget_set` del Endpoint_Acciones (R1 c5).
 *
 * Por qué un módulo y no un helper local: mientras la regla estuvo duplicada,
 * un importe podía pasar el formulario y morir en el route con el `Required` de
 * zod, un mensaje que no nombra ningún campo ni ninguna regla (R1 c6). Con una
 * sola regla eso deja de ser posible: lo que el formulario acepta es exactamente
 * lo que el endpoint acepta.
 *
 * La condición replica EXACTAMENTE la que estaba en `FormularioPresupuesto`:
 *
 *     valor !== '' && Number.isFinite(n) && n >= 0.01 && n <= techoEur
 *       && Number(n.toFixed(2)) === n
 *
 * Centralizarla no mueve el límite entre válido e inválido para ningún texto: lo
 * único nuevo es que ahora el rechazo dice POR QUÉ. Esa condición era una sola
 * conjunción, así que el orden en que se evalúan los cortes acá no cambia qué
 * textos son válidos; sólo elige cuál de los motivos se informa cuando un texto
 * incumple más de uno.
 *
 * ─── LO QUE CAMBIÓ EN LA TASK 3.3 DE `parseo-montos-anuncios` ───────────────
 *
 * El `Number(texto)` crudo se fue. Leía `'1.000'` como 1 y el importe llegaba a
 * la campaña real de Meta como `daily_budget: '100'`: un euro donde la persona
 * quiso mil, sin error, sin borde rojo y sin nada en ningún log (cláusula 1.1).
 * Ahora el QUÉ NÚMERO DICE EL TEXTO lo decide el NÚCLEO compartido
 * (`leerNumeroEscrito` en `lib/monto.ts`), que es el mismo que usa Finanzas, y lo
 * que queda acá es la POLÍTICA del presupuesto: mínimo, techo y dos decimales.
 *
 * Es el núcleo y no `parsearMonto`: la política de Finanzas (el signo prohibido,
 * «mayor que cero» en lugar de un mínimo, el tope de `numeric(14,2)`) no es la
 * del presupuesto, y sus textos tampoco.
 */

import { leerNumeroEscrito } from '../monto';

/** El mínimo que Meta acepta para un presupuesto diario, en EUR (R13 c1). */
export const MINIMO_EUR = 0.01;

/**
 * Por qué un texto no es un presupuesto. Conjunto cerrado: el catálogo de
 * `textoDeMotivo` es un `Record` completo, así que sumar un motivo sin su
 * mensaje en castellano rompe la compilación.
 *
 * `ambiguo` es el motivo que la task 3.3 sumó, y es la materialización de la
 * Bug_Condition en el presupuesto: `'1.000'` es mil o uno, y un campo de plata
 * NO ADIVINA. Es el único motivo cuyo texto no puede salir de un `Record` fijo,
 * porque tiene que ofrecer LAS DOS lecturas del texto que se escribió (2.1).
 */
export type MotivoPresupuesto =
  | 'vacio'
  | 'no_numero'
  | 'ambiguo'
  | 'bajo_el_minimo'
  | 'sobre_el_techo'
  | 'mas_de_dos_decimales';

/**
 * Unión discriminada por `ok`: cuando es `true` el importe existe y es un número
 * finito, y cuando es `false` no hay ningún `valor` que un llamador distraído
 * pueda mandar igual. Es lo que hace imposible el `budgetEur: undefined` que hoy
 * viaja al Endpoint_Acciones desde la barra de lote (R1 c1).
 *
 * POR QUÉ EL RECHAZO LLEVA SU `texto` PUESTO (task 3.3). La cláusula 3.6 pide que
 * el borde rojo del campo y el bloqueo del botón Ejecutar no puedan
 * contradecirse. Hasta acá eso se conseguía POR CONVENCIÓN: los dos consumidores
 * llamaban al mismo catálogo y había que acordarse. Con `texto` los dos leen **el
 * mismo campo del mismo objeto**, así que la contradicción deja de ser posible por
 * construcción y no por cuidado.
 *
 * Y hay un motivo que lo vuelve necesario y no sólo prolijo: la explicación de
 * `ambiguo` interpola el texto que la persona escribió, así que no existe ningún
 * `Record` de textos fijos del que pueda salir.
 */
export type PresupuestoParseado =
  | { ok: true; valor: number }
  | { ok: false; motivo: MotivoPresupuesto; texto: string };

const TEXTO_MOTIVO: Record<MotivoPresupuesto, string> = {
  vacio: 'falta el importe del presupuesto',
  no_numero: 'el importe tiene que ser un número',
  // El texto de RESPALDO de `ambiguo`, para quien tenga el motivo y no el
  // resultado a mano. El rechazo real trae en su `texto` la explicación del
  // núcleo, que nombra las dos lecturas concretas («escribí 1000 … o 1 …»): esa
  // no se puede escribir acá porque depende del texto que se tipeó.
  ambiguo: 'el importe se puede leer de dos formas: escribilo sin puntos de miles',
  bajo_el_minimo: `el importe mínimo es ${MINIMO_EUR.toFixed(2).replace('.', ',')} EUR`,
  sobre_el_techo: 'el importe supera el techo de presupuesto configurado',
  mas_de_dos_decimales: 'el importe admite como máximo dos decimales',
};

/**
 * El texto en castellano de un motivo, para que el borde rojo del formulario y
 * el bloqueo del botón Ejecutar del diálogo digan lo mismo (R1 c4, c6). Sin
 * interpolar el techo: el llamador ya lo tiene a mano y lo muestra al lado.
 *
 * LA FIRMA NO CAMBIÓ en la task 3.3, y no cambió a propósito: `(motivo) => string`
 * sobre un `Record` COMPLETO es lo que hace que sumar un motivo sin su mensaje
 * rompa la compilación. Pasarla a `(fallo: PresupuestoParseado) => string` habría
 * roto eso y habría obligado a todo consumidor a tener el objeto entero para pedir
 * un texto.
 *
 * Para mostrar un rechazo, preferir `parseo.texto`: es el mismo string para
 * los cinco motivos de texto fijo y el único correcto para `ambiguo`.
 */
export function textoDeMotivo(motivo: MotivoPresupuesto): string {
  return TEXTO_MOTIVO[motivo];
}

/**
 * Un rechazo de TEXTO FIJO: el motivo y su mensaje del catálogo, juntos.
 *
 * `ambiguo` queda excluido en el tipo y no por convención: su rechazo tiene que
 * llevar la explicación del núcleo, que nombra las dos lecturas concretas. Si
 * pudiera pasar por acá, un `rechazo('ambiguo')` distraído devolvería el texto de
 * respaldo —«escribilo sin puntos de miles»— y la persona perdería justo lo que
 * 2.1 le promete: las dos escrituras entre las que elegir.
 */
function rechazo(
  motivo: Exclude<MotivoPresupuesto, 'ambiguo'>,
): Extract<PresupuestoParseado, { ok: false }> {
  return { ok: false, motivo, texto: textoDeMotivo(motivo) };
}

/**
 * Interpreta el texto del campo de presupuesto contra el Techo_Absoluto de la
 * cuenta. El valor entra como `string` y no como `number` porque es lo que el
 * input tiene mientras el usuario escribe: convertirlo antes perdería la
 * diferencia entre "vacío" y "cero", que son dos motivos de rechazo distintos.
 *
 * Los cortes se evalúan en el orden en que están declarados los motivos. Van
 * escritos como la negación de la condición original (`!(n >= MINIMO_EUR)` y no
 * `n < MINIMO_EUR`) para conservar el comportamiento del `&&` frente a un
 * `techoEur` que no sea un número: ahí `n <= techoEur` era falso y el importe se
 * rechazaba, y acá se rechaza igual con motivo `sobre_el_techo`.
 *
 * ─── EL ORDEN DE LOS CORTES, Y POR QUÉ NO SE PUEDE REACOMODAR ───────────────
 *
 *   trim() vacío → núcleo → ambiguo | no_numero → finitud → mínimo → techo →
 *   decimales
 *
 * Cuatro cosas de este orden y de cómo están escritas son parte del contrato, no
 * estilo:
 *
 * 1. **El vacío va ANTES que todo** (3.2): `Number('  ')` era 0, así que sin este
 *    corte un campo en blanco se rechazaría hablando del mínimo de 0,01, que no
 *    le dice a nadie qué corregir. El campo tampoco se pinta de rojo: no está mal
 *    escrito, está sin escribir.
 * 2. **`ambiguo` va antes del mínimo y del techo**, y eso importa: hoy `'0.000'`
 *    devolvía `bajo_el_minimo` y `'12345.678'` devolvía `sobre_el_techo`, los dos
 *    con un mensaje que no ofrece ninguna lectura. Los dos están dentro de la
 *    Bug_Condition y tienen que decir POR QUÉ no se entienden, no hablar de rango.
 * 3. **Las negaciones se conservan escritas como están** (`!(n <= techoEur)` y no
 *    `n > techoEur`): es lo único que hace que un `techoEur` que no es un número
 *    siga rechazando TODO importe con `sobre_el_techo`, que es lo que la cláusula
 *    3.4 congela. El techo sale de `settings` y una fila ausente llega como NaN.
 * 4. **El corte de decimales se deja como `Number(n.valor.toFixed(2)) !==
 *    n.valor`** y no como `n.decimales > 2`, aunque sean equivalentes para todo
 *    decimal bien formado: es la expresión que estaba, y mantenerla saca de este
 *    módulo la pregunta de si son equivalentes en los bordes de coma flotante.
 *
 * ─── EL MAPEO DE LOS MOTIVOS DEL NÚCLEO ─────────────────────────────────────
 *
 * El núcleo tiene cuatro motivos y acá hay dos destinos. `ambiguo` es el único
 * que viaja con su explicación; los otros tres (`caracteres`, `ilegible`,
 * `vacio`) son todos `no_numero`, que es lo que el campo devolvía para ellos.
 *
 * `vacio` del núcleo NO es el `vacio` de acá y no puede mapearse a él: `'€'` (o
 * `' € '`) no lo vacía el `trim()`, así que llega hasta el núcleo, que lo deja en
 * nada al limpiar el ruido. El campo TIENE algo escrito y ese algo no es un
 * número, así que es `no_numero` — que además es lo que devolvía antes.
 *
 * Y dos consecuencias del núcleo que quedan pinneadas en los tests para que sean
 * deliberadas y no descubrimientos:
 *
 *   · **los negativos siguen siendo `bajo_el_minimo`**, no `no_numero`: el núcleo
 *     devuelve `-5` como número (el signo es política del llamador) y el corte del
 *     mínimo lo agarra igual que antes;
 *   · **`'.'` pasa de `no_numero` a `bajo_el_minimo`**: el núcleo lo resuelve como
 *     0 donde `Number('.')` daba NaN. Sigue siendo un rechazo y cambia el mensaje.
 *     Es la familia (f) de §Alcance, declarada y no corregida porque corregirla
 *     cambiaría el mensaje de `parsearMonto('.')`, que 3.13 congela.
 */
export function parsearPresupuesto(texto: string, techoEur: number): PresupuestoParseado {
  // `Number('  ')` es 0, así que un campo con espacios ya se rechazaba por el
  // mínimo. Se informa como vacío porque hablar del mínimo de 0,01 frente a un
  // campo que el usuario ve en blanco no le dice qué corregir.
  if (texto.trim() === '') return rechazo('vacio');

  // Al núcleo se le pasa el texto TAL COMO SE ESCRIBIÓ y no una versión limpia:
  // la explicación de la ambigüedad lo cita («"€1.000" se puede leer…»), y eso
  // sólo sale bien si el núcleo ve el original.
  const n = leerNumeroEscrito(texto);
  if (!n.ok) {
    return n.motivo === 'ambiguo'
      ? { ok: false, motivo: 'ambiguo', texto: n.explicacion }
      : rechazo('no_numero');
  }
  // El núcleo NO chequea la finitud (lo dice su propio tipo), así que un texto de
  // 400 dígitos vuelve con `valor: Infinity`. Acá se rechaza como `no_numero`,
  // que es lo que devolvía cuando `Number` daba Infinity.
  if (!Number.isFinite(n.valor)) return rechazo('no_numero');
  if (!(n.valor >= MINIMO_EUR)) return rechazo('bajo_el_minimo');
  if (!(n.valor <= techoEur)) return rechazo('sobre_el_techo');
  if (Number(n.valor.toFixed(2)) !== n.valor) return rechazo('mas_de_dos_decimales');

  return { ok: true, valor: n.valor };
}
