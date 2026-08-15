/**
 * Seleccion_Activa y Filtro_Cascada (task 6.1 de gestion-campanas-anuncios).
 * Pura: sin `pg` y sin red. Acá viven la resolución del conflicto 50/100
 * (MAX_SELECCION = 100 contra MAX_CASCADA = 50, decisión del design §"El
 * conflicto numérico") y la garantía de que ninguna Accion_Lote cruza niveles:
 * la Seleccion lleva el `nivel` junto a los ids, así un tilde hecho en
 * campañas no puede confirmarse como un lote de conjuntos (R9 c3, c12).
 *
 * La tabla de transiciones del design §6 está implementada en `aplicarEvento`,
 * que es el reductor que usa el Gestor_Anuncios — la Property 8 (task 6.2) lo
 * ejercita con secuencias de eventos al azar, así que lo que se testea es
 * exactamente lo que corre en la pantalla.
 */

import type { NivelAds } from './tipos';

export const MAX_SELECCION = 100; // R9 c9, tope que el Endpoint_Acciones ya valida
export const MAX_CASCADA = 50; // R8 c1

export type Seleccion = {
  /** El nivel al que pertenecen los ids. Sin esto no se puede garantizar R9 c3. */
  nivel: NivelAds;
  ids: readonly string[];
};

export type Cascada = {
  /** El nivel de los ids del filtro, no el Nivel_Activo. */
  nivel: 'campaign' | 'adset';
  ids: readonly string[];
  /** Cuántos se descartaron al armarla, para el mensaje de R8 c14 y R9 c4. */
  descartados: number;
  motivo: 'tope' | 'otra_cuenta' | 'inexistente' | null;
};

export const seleccionVacia = (nivel: NivelAds): Seleccion => ({ nivel, ids: [] });

/**
 * Agrega un id respetando el tope. Devuelve la selección intacta y
 * `agregado: false` cuando ya hay 100 (R9 c10): la fila no se tilda y el
 * llamador avisa. Un id ya tildado tampoco se agrega dos veces.
 */
export function tildar(s: Seleccion, id: string): { seleccion: Seleccion; agregado: boolean } {
  if (s.ids.includes(id) || s.ids.length >= MAX_SELECCION) {
    return { seleccion: s, agregado: false };
  }
  return { seleccion: { ...s, ids: [...s.ids, id] }, agregado: true };
}

/** Quita un id. Tilde fuera del tope: destildar siempre está permitido. */
export function destildar(s: Seleccion, id: string): Seleccion {
  return s.ids.includes(id) ? { ...s, ids: s.ids.filter((x) => x !== id) } : s;
}

/**
 * Tilda las filas de la página en pantalla, hasta completar 100 (R9 c8).
 * Mezcla con la selección previa: lo ya tildado se conserva, y las filas de
 * las demás páginas no se tocan.
 */
export function tildarPagina(s: Seleccion, idsPagina: readonly string[]): Seleccion {
  const ya = new Set(s.ids);
  const out: string[] = [...s.ids];
  for (const id of idsPagina) {
    if (out.length >= MAX_SELECCION) break;
    if (ya.has(id)) continue;
    ya.add(id);
    out.push(id);
  }
  return { ...s, ids: out };
}

/**
 * Convierte la Seleccion_Activa del nivel anterior en Filtro_Cascada del nivel
 * nuevo (R9 c4). Recorta a MAX_CASCADA conservando el ORDEN EN QUE VIENEN en
 * `idsEnOrdenDeTabla`, que el llamador arma según el Orden_Tabla vigente: el
 * recorte es determinístico y es el mismo orden que el usuario está viendo
 * (decisión del design para el conflicto 50/100).
 */
export function aCascada(
  s: Seleccion,
  idsEnOrdenDeTabla?: readonly string[],
): Cascada {
  if (s.nivel === 'ad') {
    throw new Error('aCascada: un anuncio no puede ser Filtro_Cascada (R8 c1)');
  }
  const nivel = s.nivel;
  const orden = idsEnOrdenDeTabla ?? s.ids;
  const set = new Set(s.ids);
  const ordenados: string[] = [];
  for (const id of orden) {
    if (set.has(id) && !ordenados.includes(id)) ordenados.push(id);
  }
  const descartados = s.ids.length - ordenados.length;
  const ids = ordenados.slice(0, MAX_CASCADA);
  const recortados = ordenados.length - ids.length;
  return {
    nivel,
    ids,
    descartados: descartados + recortados,
    motivo: recortados > 0 ? 'tope' : null,
  };
}

/**
 * Normaliza una Cascada contra el Nivel_Activo y la cuenta vigente:
 *   - la vacía cuando el Nivel_Activo pasa al mismo nivel de los ids o más
 *     arriba (R8 c10);
 *   - conserva únicamente ids de la cuenta publicitaria seleccionada, sin
 *     repetidos, y reporta los descartados (R8 c8, c9).
 */
export function normalizarCascada(
  c: Cascada,
  nivelActivo: NivelAds,
  idsDeLaCuenta: ReadonlySet<string>,
): Cascada {
  const subeAlNivel =
    c.nivel === 'campaign' ? nivelActivo === 'campaign' : nivelActivo !== 'ad';
  if (subeAlNivel) {
    return { nivel: c.nivel, ids: [], descartados: c.descartados + c.ids.length, motivo: null };
  }
  const vistos = new Set<string>();
  const ids: string[] = [];
  let descartados = 0;
  let motivo: Cascada['motivo'] = null;
  for (const id of c.ids) {
    if (vistos.has(id)) {
      descartados += 1;
      continue;
    }
    vistos.add(id);
    if (!idsDeLaCuenta.has(id)) {
      descartados += 1;
      motivo = 'otra_cuenta';
      continue;
    }
    ids.push(id);
  }
  return { nivel: c.nivel, ids, descartados: c.descartados + descartados, motivo };
}

// ─────────────────────────────────────────────────────────────────────────────
// El estado conjunto y sus transiciones (la tabla del design §6, implementada)
// ─────────────────────────────────────────────────────────────────────────────

export type EstadoSeleccion = {
  /** El Nivel_Activo. La Seleccion siempre pertenece a este nivel. */
  nivel: NivelAds;
  seleccion: Seleccion;
  /** null = Filtro_Cascada vacío (Chip_Cascada oculto). */
  cascada: Cascada | null;
};

export type EventoSeleccion =
  | { tipo: 'tildar'; id: string }
  | { tipo: 'destildar'; id: string }
  | { tipo: 'tildar_todas'; idsPagina: readonly string[] }
  | {
      tipo: 'cambiar_nivel';
      nivel: NivelAds;
      /** Las filas del nivel previo en el Orden_Tabla vigente (para `aCascada`). */
      idsEnOrdenDeTabla?: readonly string[];
      /** Ids del nivel de la cascada que pertenecen a la cuenta vigente (R8 c8). */
      idsDeLaCuenta: ReadonlySet<string>;
    }
  | { tipo: 'cambiar_filtro' }
  | { tipo: 'limpiar_cascada' };

export const estadoInicial = (nivel: NivelAds): EstadoSeleccion => ({
  nivel,
  seleccion: seleccionVacia(nivel),
  cascada: null,
});

/**
 * Un paso de la máquina de estados. Es LA tabla de transiciones del design §6:
 *
 * | Evento | Seleccion_Activa | Filtro_Cascada |
 * |---|---|---|
 * | tildar / destildar / tildar_todas | cambia según el tope de 100 | sin cambios |
 * | bajar de nivel con 1..100 tildados | queda en 0 | primeros 50 en Orden_Tabla (R9 c4) |
 * | bajar de nivel con 0 tildados | queda en 0 | sin cambios (R9 c13, R1 c3) |
 * | subir al nivel de los ids o más arriba | queda en 0 | se vacía (R8 c10) |
 * | misma pestaña | sin cambios | sin cambios (R1 c15) |
 * | cambiar un control de Barra_Filtros | queda en 0 | sin cambios (R9 c6) |
 * | limpiar el Chip_Cascada | sin cambios | se vacía (R8 c6) |
 */
export function aplicarEvento(e: EstadoSeleccion, ev: EventoSeleccion): EstadoSeleccion {
  switch (ev.tipo) {
    case 'tildar': {
      const { seleccion, agregado } = tildar(e.seleccion, ev.id);
      return agregado ? { ...e, seleccion } : e;
    }
    case 'destildar':
      return { ...e, seleccion: destildar(e.seleccion, ev.id) };
    case 'tildar_todas':
      return { ...e, seleccion: tildarPagina(e.seleccion, ev.idsPagina) };
    case 'cambiar_filtro':
      // R9 c6: la selección se vacía, la cascada se conserva.
      return { ...e, seleccion: seleccionVacia(e.nivel) };
    case 'limpiar_cascada':
      // R8 c6: sólo se vacía la cascada.
      return { ...e, cascada: null };
    case 'cambiar_nivel': {
      if (ev.nivel === e.nivel) return e; // R1 c15: sin pedido nuevo ni cambios
      const siguiente: NivelAds = ev.nivel;
      const baja =
        (siguiente === 'adset' && e.nivel === 'campaign') ||
        (siguiente === 'ad' && e.nivel !== 'ad');

      let cascada = e.cascada;
      if (baja) {
        // R9 c4 / c13: con selección se arma la cascada nueva; con 0, la
        // cascada previa se conserva (R1 c3 conserva el Filtro_Cascada).
        if (e.seleccion.ids.length > 0) {
          cascada = aCascada(e.seleccion, ev.idsEnOrdenDeTabla);
        }
      } else if (cascada) {
        // Subió al nivel de los ids o más arriba: se vacía (R8 c10). Una
        // cascada sin ids ES null: el Chip_Cascada se oculta.
        const normalizada = normalizarCascada(cascada, siguiente, ev.idsDeLaCuenta);
        cascada = normalizada.ids.length === 0 ? null : normalizada;
      }

      // R9 c5: la selección del nivel nuevo arranca en 0 (invariante de P8).
      return { nivel: siguiente, seleccion: seleccionVacia(siguiente), cascada };
    }
  }
}
