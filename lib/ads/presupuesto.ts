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
 */

/** El mínimo que Meta acepta para un presupuesto diario, en EUR (R13 c1). */
export const MINIMO_EUR = 0.01;

/**
 * Por qué un texto no es un presupuesto. Conjunto cerrado: el catálogo de
 * `textoDeMotivo` es un `Record` completo, así que sumar un motivo sin su
 * mensaje en castellano rompe la compilación.
 */
export type MotivoPresupuesto =
  | 'vacio'
  | 'no_numero'
  | 'bajo_el_minimo'
  | 'sobre_el_techo'
  | 'mas_de_dos_decimales';

/**
 * Unión discriminada por `ok`: cuando es `true` el importe existe y es un número
 * finito, y cuando es `false` no hay ningún `valor` que un llamador distraído
 * pueda mandar igual. Es lo que hace imposible el `budgetEur: undefined` que hoy
 * viaja al Endpoint_Acciones desde la barra de lote (R1 c1).
 */
export type PresupuestoParseado =
  | { ok: true; valor: number }
  | { ok: false; motivo: MotivoPresupuesto };

const TEXTO_MOTIVO: Record<MotivoPresupuesto, string> = {
  vacio: 'falta el importe del presupuesto',
  no_numero: 'el importe tiene que ser un número',
  bajo_el_minimo: `el importe mínimo es ${MINIMO_EUR.toFixed(2).replace('.', ',')} EUR`,
  sobre_el_techo: 'el importe supera el techo de presupuesto configurado',
  mas_de_dos_decimales: 'el importe admite como máximo dos decimales',
};

/**
 * El texto en castellano de un motivo, para que el borde rojo del formulario y
 * el bloqueo del botón Ejecutar del diálogo digan lo mismo (R1 c4, c6). Sin
 * interpolar el techo: el llamador ya lo tiene a mano y lo muestra al lado.
 */
export function textoDeMotivo(motivo: MotivoPresupuesto): string {
  return TEXTO_MOTIVO[motivo];
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
 */
export function parsearPresupuesto(texto: string, techoEur: number): PresupuestoParseado {
  // `Number('  ')` es 0, así que un campo con espacios ya se rechazaba por el
  // mínimo. Se informa como vacío porque hablar del mínimo de 0,01 frente a un
  // campo que el usuario ve en blanco no le dice qué corregir.
  if (texto.trim() === '') return { ok: false, motivo: 'vacio' };

  const n = Number(texto);
  if (!Number.isFinite(n)) return { ok: false, motivo: 'no_numero' };
  if (!(n >= MINIMO_EUR)) return { ok: false, motivo: 'bajo_el_minimo' };
  if (!(n <= techoEur)) return { ok: false, motivo: 'sobre_el_techo' };
  if (Number(n.toFixed(2)) !== n) return { ok: false, motivo: 'mas_de_dos_decimales' };

  return { ok: true, valor: n };
}
