/**
 * Capa de datos del tablero kanban (migración 031).
 * Plan `tasks/usuarios-y-tareas/00-PLAN-USUARIOS-Y-TAREAS.md` §5, contrato de
 * firmas CONGELADO: T05 y T06 programan contra esta lista exacta.
 *
 * El molde es `lib/queries/saldo.ts`: filas tipadas, mapeo snake_case → camelCase
 * a mano en un `.map()` explícito, `tx()` de `lib/db.ts` para lo multi-tabla, y
 * una clase de error de dominio (`TareaInputError`) que traduce los SQLSTATE de
 * Postgres a castellano ACÁ, no en el route.
 *
 * Lo que esta capa NO hace, a propósito: decidir quién puede editar qué. Eso lo
 * decide el route (T05 §4), porque acá no hay sesión. La regla —un no-admin crea
 * cualquier tarea y edita sólo las suyas, el admin edita todas— no se expresa con
 * un `usuarioId` de parámetro "por si acaso": una capa que a veces filtra por
 * usuario y a veces no es una capa que nadie puede razonar.
 */

import type { PoolClient } from 'pg';
import { q, q1, tx, getPool } from '@/lib/db';

// ─── Tipos (plan §5) ──────────────────────────────────────────────────────

export type Columna = 'por_hacer' | 'en_progreso' | 'en_revision' | 'hecho';
export type Prioridad = 'alta' | 'media' | 'baja';

export const COLUMNAS: readonly Columna[] = [
  'por_hacer',
  'en_progreso',
  'en_revision',
  'hecho',
] as const;
export const PRIORIDADES: readonly Prioridad[] = ['alta', 'media', 'baja'] as const;

export type TareaLink = {
  id: number;
  url: string;
  etiqueta: string | null;
  posicion: number;
};

export type TareaComentario = {
  id: number;
  usuarioId: number;
  usuarioNombre: string;
  cuerpo: string;
  createdAt: string;
};

export type Tarea = {
  id: number;
  titulo: string;
  notas: string | null;
  columna: Columna;
  prioridad: Prioridad;
  posicion: number;
  asignadoA: number;
  asignadoNombre: string;
  creadoPor: number | null;
  creadoPorNombre: string | null;
  /** YYYY-MM-DD */
  venceEl: string | null;
  /** ISO */
  hechaAt: string | null;
  createdAt: string;
  updatedAt: string;
  links: TareaLink[];
  comentarios: TareaComentario[];
};

/**
 * Un pedido mal armado, no una falla del servidor. Existe para que los routes
 * puedan contestar 400 con un mensaje legible sin comparar el texto del error,
 * igual que `SaldoInputError` en `saldo.ts` y `UsuarioInputError` en
 * `usuarios.ts`.
 */
export class TareaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TareaInputError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const ISO = (d: Date): string => d.toISOString();

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

function constraintOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    return (err as { constraint?: string }).constraint;
  }
  return undefined;
}

/**
 * Traduce los SQLSTATE de la 031 a castellano. El route sólo hace
 * `if (err instanceof TareaInputError)` y le pone un status; el mapeo del código
 * vive acá. Sin esto, el nombre del constraint sale crudo a la pantalla — ya
 * pasó con los movimientos de finanzas y está en registro.md.
 *
 *  · 23514 CHECK: `columna` o `prioridad` fuera del vocabulario, título/cuerpo
 *    vacío, la URL sin `http(s)://`, o la bicondicional de `hecha_at`.
 *  · 23503 FK: asignar/crear/comentar apuntando a un usuario que no existe.
 *  · 23505 UNIQUE: no hay uno hoy en tareas, pero se traduce por si aparece.
 */
function tareaErrorMessage(err: unknown): Error {
  const code = codeOf(err);
  const constraint = constraintOf(err);

  if (code === '23503') {
    return new TareaInputError('el usuario indicado no existe');
  }
  if (code === '23505') {
    return new TareaInputError('ya existe un registro con esos datos');
  }
  if (code === '23514') {
    if (constraint === 'tarea_links_url_http') {
      return new TareaInputError('el link tiene que empezar con http:// o https://');
    }
    if (constraint === 'tareas_hecha_at_coherente') {
      // No debería salir por acá: moverTarea maneja hecha_at. Si sale, es un bug
      // de esta capa, no un dato del cliente — pero un mensaje legible igual.
      return new TareaInputError(
        'estado inconsistente: hecha_at sólo puede tener valor cuando la columna es "hecho"',
      );
    }
    return new TareaInputError(
      'datos inválidos: la columna tiene que ser por_hacer/en_progreso/en_revision/hecho, ' +
        'la prioridad alta/media/baja, y ni el título ni el comentario pueden estar vacíos',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ─── Filas crudas y su mapeo ────────────────────────────────────────────────

// `bigserial` llega como string de node-pg (Number() en cada id). `posicion` es
// `integer` (int4) y pg lo devuelve como número: NO se castea con ::float8 ni se
// pasa por Number() forzado, a diferencia de los `numeric` de saldo.ts — acá no
// hay plata que convertir.
type LinkRow = {
  id: number | string;
  url: string;
  etiqueta: string | null;
  posicion: number | string;
};

type ComentarioRow = {
  id: number | string;
  usuario_id: number | string;
  usuario_nombre: string;
  cuerpo: string;
  created_at: string;
};

type TareaRow = {
  id: number | string;
  titulo: string;
  notas: string | null;
  columna: Columna;
  prioridad: Prioridad;
  posicion: number | string;
  asignado_a: number | string;
  asignado_nombre: string;
  creado_por: number | string | null;
  creado_por_nombre: string | null;
  vence_el: string | null;
  hecha_at: string | null;
  created_at: Date;
  updated_at: Date;
  links: LinkRow[];
  comentarios: ComentarioRow[];
};

function toLink(r: LinkRow): TareaLink {
  return {
    id: Number(r.id),
    url: r.url,
    etiqueta: r.etiqueta,
    posicion: Number(r.posicion),
  };
}

function toComentario(r: ComentarioRow): TareaComentario {
  return {
    id: Number(r.id),
    usuarioId: Number(r.usuario_id),
    usuarioNombre: r.usuario_nombre,
    cuerpo: r.cuerpo,
    // El jsonb_build_object lo trae como texto ISO ya (to_char de la subconsulta).
    createdAt: r.created_at,
  };
}

function toTarea(r: TareaRow): Tarea {
  return {
    id: Number(r.id),
    titulo: r.titulo,
    notas: r.notas,
    columna: r.columna,
    prioridad: r.prioridad,
    posicion: Number(r.posicion),
    asignadoA: Number(r.asignado_a),
    asignadoNombre: r.asignado_nombre,
    creadoPor: r.creado_por === null ? null : Number(r.creado_por),
    creadoPorNombre: r.creado_por_nombre,
    venceEl: r.vence_el,
    hechaAt: r.hecha_at,
    createdAt: ISO(r.created_at),
    updatedAt: ISO(r.updated_at),
    links: (r.links ?? []).map(toLink),
    comentarios: (r.comentarios ?? []).map(toComentario),
  };
}

// ─── SQL de lectura ─────────────────────────────────────────────────────────

// Las columnas de la tarjeta + el nombre del asignado y del creador + los links y
// los comentarios como jsonb.
//
// (1) Los links y los comentarios salen de DOS SUBCONSULTAS CORRELACIONADAS con
//     jsonb_agg, NO de un JOIN plano a tarea_links/tarea_comentarios. Una tarjeta
//     con 3 links y 2 comentarios saldría 6 veces con un join, y cualquier LIMIT o
//     count de la query pasa a mentir. Mismo razonamiento que
//     `lib/queries/funnel.ts:542-577`.
// (2) COALESCE(..., '[]'::jsonb): una tarjeta sin links devuelve '[]', no NULL, así
//     el .map() del cliente no tira sobre una lista vacía.
// (3) JOIN usuarios ua (INNER) para el asignado y LEFT JOIN uc para el creador.
//     `asignado_a` es NOT NULL con FK, así que el inner join no pierde filas — y si
//     algún día perdiera una, es un dato roto que TIENE que desaparecer de la
//     pantalla en vez de mostrarse a medias. `creado_por` sí es nullable (fallback
//     de D10, scripts), así que LEFT JOIN y creadoPorNombre: null.
const SELECT_TAREA = `
  SELECT
    t.id, t.titulo, t.notas, t.columna, t.prioridad, t.posicion,
    t.asignado_a, ua.nombre AS asignado_nombre,
    t.creado_por, uc.nombre AS creado_por_nombre,
    t.vence_el::text AS vence_el,
    -- hecha_at a ISO text en SQL (no el Date crudo de pg): el contrato lo promete
    -- como string ISO, y dos Date distintos que representan el mismo instante NO
    -- son iguales con Object.is, así que comparar el reloj del archivado fallaría
    -- en un toBe() del test aunque el valor sea idéntico.
    to_char(t.hecha_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS hecha_at,
    t.created_at, t.updated_at,
    (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object('id', l.id, 'url', l.url, 'etiqueta', l.etiqueta, 'posicion', l.posicion)
          ORDER BY l.posicion, l.id
        ),
        '[]'::jsonb
      )
      FROM tarea_links l WHERE l.tarea_id = t.id
    ) AS links,
    (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', c.id, 'usuario_id', c.usuario_id, 'usuario_nombre', cu.nombre,
            'cuerpo', c.cuerpo, 'created_at', to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF')
          )
          ORDER BY c.created_at, c.id
        ),
        '[]'::jsonb
      )
      FROM tarea_comentarios c
      JOIN usuarios cu ON cu.id = c.usuario_id
      WHERE c.tarea_id = t.id
    ) AS comentarios
  FROM tareas t
  JOIN usuarios ua ON ua.id = t.asignado_a
  LEFT JOIN usuarios uc ON uc.id = t.creado_por`;

/** Una tarjeta puntual por id. La usan crearTarea/editarTarea para devolver el
 *  estado final ya rehidratado. */
async function tareaPorId(id: number): Promise<Tarea | null> {
  const row = await q1<TareaRow>(`${SELECT_TAREA} WHERE t.id = $1`, [id]);
  return row ? toTarea(row) : null;
}

/**
 * El tablero. `asignadoA: null` (o ausente) = todas las personas; el switch de
 * "todas las tareas". `archivadas: true` incluye las archivadas.
 *
 * (4) ORDER BY posicion, id (con desempate): dos tarjetas pueden compartir
 *     `posicion` mientras una reescritura está a mitad de camino, y sin el
 *     desempate el orden que ve el usuario cambia entre dos refrescos sin que nadie
 *     haya tocado nada.
 *
 * El SQL dinámico se arma empujando a un array de params y usando su `.length`
 * para el número del placeholder — NUNCA con template strings de valores (§9.3).
 */
export async function listarTareas(f: {
  asignadoA?: number | null;
  archivadas?: boolean;
}): Promise<Tarea[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!f.archivadas) {
    where.push('t.archivada_at IS NULL');
  }
  if (f.asignadoA != null) {
    params.push(f.asignadoA);
    where.push(`t.asignado_a = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await q<TareaRow>(
    `${SELECT_TAREA} ${whereSql} ORDER BY t.posicion, t.id`,
    params,
  );
  return rows.map(toTarea);
}

// ─── Escritura de una tarjeta ───────────────────────────────────────────────

/**
 * Crea una tarjeta. Lo único obligatorio es el título y el asignado; el resto
 * toma los defaults de la 031 (columna 'por_hacer', prioridad 'media', posicion 0,
 * notas/vence null).
 *
 * `creadoPor` es null-able a propósito: las tarjetas que cree un script o una
 * sesión del fallback de DASHBOARD_PASSWORD (D10) no tienen un usuario detrás.
 */
export async function crearTarea(
  t: {
    titulo: string;
    asignadoA: number;
    notas?: string | null;
    prioridad?: Prioridad;
    columna?: Columna;
    venceEl?: string | null;
  },
  creadoPor: number | null,
): Promise<Tarea> {
  const titulo = t.titulo.trim();
  if (titulo.length === 0) {
    throw new TareaInputError('el título no puede estar vacío');
  }
  try {
    // Si nace en 'hecho', el CHECK bicondicional exige hecha_at: se puebla acá,
    // igual que lo hace moverTarea. Cualquier otra columna → hecha_at NULL.
    const row = await q1<{ id: string }>(
      `INSERT INTO tareas (titulo, asignado_a, notas, prioridad, columna, vence_el, creado_por, hecha_at)
       VALUES ($1, $2, $3, COALESCE($4, 'media'), COALESCE($5, 'por_hacer'), $6::date, $7,
               CASE WHEN COALESCE($5, 'por_hacer') = 'hecho' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        titulo,
        t.asignadoA,
        t.notas ?? null,
        t.prioridad ?? null,
        t.columna ?? null,
        t.venceEl ?? null,
        creadoPor,
      ],
    );
    return (await tareaPorId(Number(row!.id)))!;
  } catch (err) {
    throw tareaErrorMessage(err);
  }
}

/**
 * Edita los campos de contenido de una tarjeta: título, notas, prioridad,
 * asignado y fecha de vencimiento. `undefined` = no lo toques (para notas y
 * vence_el, `null` sí es un valor: borra las notas / la fecha), igual que
 * updateAccount de saldo.ts.
 *
 * NO cambia `columna` ni `posicion` ni `hecha_at`: eso es moverTarea, porque el
 * reloj del archivado (D13) y el orden (D12) tienen su propia lógica y mezclarlos
 * acá es la forma de romper la bicondicional del CHECK sin querer.
 */
export async function editarTarea(
  id: number,
  cambios: {
    titulo?: string;
    notas?: string | null;
    prioridad?: Prioridad;
    asignadoA?: number;
    venceEl?: string | null;
  },
): Promise<Tarea> {
  const actual = await q1<{
    titulo: string;
    notas: string | null;
    prioridad: Prioridad;
    asignado_a: string;
    vence_el: string | null;
  }>(
    `SELECT titulo, notas, prioridad, asignado_a, vence_el::text AS vence_el
       FROM tareas WHERE id = $1`,
    [id],
  );
  if (!actual) throw new TareaInputError('esa tarea no existe');

  const titulo = cambios.titulo !== undefined ? cambios.titulo.trim() : actual.titulo;
  if (titulo.length === 0) {
    throw new TareaInputError('el título no puede estar vacío');
  }
  const notas = cambios.notas !== undefined ? cambios.notas : actual.notas;
  const prioridad = cambios.prioridad ?? actual.prioridad;
  const asignadoA = cambios.asignadoA ?? Number(actual.asignado_a);
  const venceEl = cambios.venceEl !== undefined ? cambios.venceEl : actual.vence_el;

  try {
    await q(
      `UPDATE tareas
          SET titulo = $2, notas = $3, prioridad = $4, asignado_a = $5, vence_el = $6::date
        WHERE id = $1`,
      [id, titulo, notas, prioridad, asignadoA, venceEl],
    );
  } catch (err) {
    throw tareaErrorMessage(err);
  }
  const tarea = await tareaPorId(id);
  if (!tarea) throw new TareaInputError('esa tarea no existe');
  return tarea;
}

// ─── Mover y reordenar (D12, D13) ───────────────────────────────────────────

// Reescribe `posicion` como 10, 20, 30… para la lista de ids dada, en UNA sola
// sentencia con unnest WITH ORDINALITY — NO un UPDATE por tarjeta en un loop (con
// 30 tarjetas serían 30 round-trips dentro de una transacción abierta).
const REESCRIBIR_POSICIONES_SQL = `
  UPDATE tareas AS t
     SET posicion = (ord.rn * 10)::int
    FROM unnest($1::bigint[]) WITH ORDINALITY AS ord(id, rn)
   WHERE t.id = ord.id`;

/**
 * Trae la columna actual y el hecha_at de una lista de ids. Sirve para validar
 * pertenencia antes de reescribir posiciones. Usa el `c` de la transacción: se
 * llama SIEMPRE desde dentro de un tx().
 */
async function filasDe(
  c: PoolClient,
  ids: number[],
): Promise<Map<number, { columna: Columna; hechaAt: string | null }>> {
  const res = await c.query<{ id: string; columna: Columna; hecha_at: string | null }>(
    `SELECT id, columna, hecha_at FROM tareas WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  const m = new Map<number, { columna: Columna; hechaAt: string | null }>();
  for (const r of res.rows) {
    m.set(Number(r.id), { columna: r.columna, hechaAt: r.hecha_at });
  }
  return m;
}

/**
 * Mueve la tarjeta `id` a la columna `a` y reescribe el orden de ESA columna con
 * `ordenDeLaColumna` (la lista completa y ordenada de ids que quedan en la columna
 * destino, incluyendo `id`).
 *
 * Todo dentro de UN solo tx() con el `c` del callback. NUNCA q() adentro de tx:
 * toma otra conexión del pool y queda fuera de la transacción, con la transacción
 * abierta esperando — camino directo a un deadlock.
 *
 * hecha_at se maneja acá (D13):
 *  · entra a 'hecho' (no lo estaba) → hecha_at = now()
 *  · sale de 'hecho'                → hecha_at = NULL
 *  · ya estaba en 'hecho' y se reordena SIN cambiar de columna → NO se toca:
 *    reordenar una tarjeta terminada no puede reiniciarle el reloj del archivado
 *    (son dos días desde que se terminó, no desde el último manoseo).
 */
export async function moverTarea(
  id: number,
  a: Columna,
  ordenDeLaColumna: number[],
): Promise<void> {
  if (!COLUMNAS.includes(a)) {
    throw new TareaInputError(`columna inválida: "${a}"`);
  }
  if (!ordenDeLaColumna.includes(id)) {
    throw new TareaInputError(
      `la tarjeta ${id} tiene que estar en la lista de orden de la columna destino`,
    );
  }

  try {
    await tx(async (c) => {
      const filas = await filasDe(c, ordenDeLaColumna);

      const laQueSeMueve = filas.get(id);
      if (!laQueSeMueve) {
        throw new TareaInputError(`la tarea ${id} no existe`);
      }

      // Todos los ids del orden tienen que existir. Los que NO son `id` tienen que
      // estar YA en la columna destino (a `id` la estamos moviendo hacia `a`).
      for (const otroId of ordenDeLaColumna) {
        const fila = filas.get(otroId);
        if (!fila) {
          throw new TareaInputError(`la tarea ${otroId} no existe`);
        }
        if (otroId !== id && fila.columna !== a) {
          throw new TareaInputError(
            `la tarea ${otroId} no pertenece a la columna "${a}" (está en "${fila.columna}")`,
          );
        }
      }

      // hecha_at según la transición de la tarjeta que se mueve.
      const estabaEnHecho = laQueSeMueve.columna === 'hecho';
      const quedaEnHecho = a === 'hecho';
      if (quedaEnHecho && !estabaEnHecho) {
        await c.query(`UPDATE tareas SET columna = $2, hecha_at = now() WHERE id = $1`, [id, a]);
      } else if (!quedaEnHecho && estabaEnHecho) {
        await c.query(`UPDATE tareas SET columna = $2, hecha_at = NULL WHERE id = $1`, [id, a]);
      } else {
        // hecho→hecho (reordenar dentro) o no-hecho→no-hecho: hecha_at intacto.
        await c.query(`UPDATE tareas SET columna = $2 WHERE id = $1`, [id, a]);
      }

      await c.query(REESCRIBIR_POSICIONES_SQL, [ordenDeLaColumna]);
    });
  } catch (err) {
    if (err instanceof TareaInputError) throw err;
    throw tareaErrorMessage(err);
  }
}

/**
 * Reordena una columna sin cambiar de columna a nadie: reescribe `posicion` como
 * 10, 20, 30… para `ordenDeIds`. Valida que TODOS los ids pertenezcan a `columna`
 * y que la lista sea COMPLETA. Si falla, TareaInputError con cuántos esperaba vs
 * cuántos llegaron, y la transacción hace ROLLBACK: una lista incompleta dejaría a
 * las que faltan con la posicion vieja, intercaladas de forma impredecible.
 *
 * hecha_at NO se toca acá: reordenar no cambia de columna, así que el reloj del
 * archivado no se mueve (D13).
 *
 * SIN CALLER EN PRODUCCIÓN, A PROPÓSITO. El contrato de §5 del plan la pide
 * como función separada, pero `/api/tareas/mover` (T05) resolvió los dos casos
 * —mover entre columnas y reordenar dentro de la misma— con un solo endpoint y
 * una sola llamada a `moverTarea(id, columnaActual, orden)`: pasarle la misma
 * columna en la que ya estaba ES reordenar. Duplicar el camino con un segundo
 * endpoint que llame a esta función habría dejado dos formas de escribir
 * `posicion` para el mismo caso, que es peor que tener una función de sobra.
 * Se queda exportada y testeada (§6, tests 7 y 8 de T02) porque es parte del
 * contrato congelado; si algún día hace falta reordenar sin pasar por `mover`
 * (por ejemplo una vista que no conoce la columna destino), ya existe.
 */
export async function reordenarColumna(columna: Columna, ordenDeIds: number[]): Promise<void> {
  if (!COLUMNAS.includes(columna)) {
    throw new TareaInputError(`columna inválida: "${columna}"`);
  }

  try {
    await tx(async (c) => {
      const filas = await filasDe(c, ordenDeIds);

      for (const cid of ordenDeIds) {
        const fila = filas.get(cid);
        if (!fila) {
          throw new TareaInputError(`la tarea ${cid} no existe`);
        }
        if (fila.columna !== columna) {
          throw new TareaInputError(
            `la tarea ${cid} no pertenece a la columna "${columna}" (está en "${fila.columna}")`,
          );
        }
      }

      // La lista tiene que ser COMPLETA: tantos ids como tarjetas no archivadas hay
      // en esa columna. Sin esto, una lista incompleta deja a las que faltan con la
      // posicion vieja.
      const cuenta = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tareas WHERE columna = $1 AND archivada_at IS NULL`,
        [columna],
      );
      const esperaba = Number(cuenta.rows[0]!.n);
      if (esperaba !== ordenDeIds.length) {
        throw new TareaInputError(
          `la lista de orden está incompleta: la columna "${columna}" tiene ${esperaba} tarjetas y llegaron ${ordenDeIds.length}`,
        );
      }

      await c.query(REESCRIBIR_POSICIONES_SQL, [ordenDeIds]);
    });
  } catch (err) {
    if (err instanceof TareaInputError) throw err;
    throw tareaErrorMessage(err);
  }
}

/**
 * Borra una tarjeta. El CASCADE de la 031 se lleva sus links y comentarios; los
 * FK RESTRICT de `asignado_a` y `creado_por` NO se disparan (borrar la tarjeta no
 * borra al usuario).
 */
export async function borrarTarea(id: number): Promise<void> {
  await q(`DELETE FROM tareas WHERE id = $1`, [id]);
}

// ─── Links ──────────────────────────────────────────────────────────────────

/**
 * Agrega un link a una tarjeta. La `posicion` nace al final (max + 10).
 *
 * z.string().url() del route (T05) acepta `javascript:alert(1)` según WHATWG, así
 * que el protocolo se valida ACÁ además del CHECK `tarea_links_url_http` de la
 * 031: sin esta validación, un `javascript:` daría un 23514 crudo (un 500 feo) en
 * vez de un TareaInputError legible. El CHECK es la última defensa; esto es la
 * primera.
 */
export async function agregarLink(
  tareaId: number,
  url: string,
  etiqueta?: string | null,
): Promise<TareaLink> {
  const limpia = url.trim();
  // http/https explícito. No alcanza con z.string().url(): 'javascript:alert(1)'
  // es una URL válida para el WHATWG y pasaría el zod del route.
  if (!/^https?:\/\/.+/i.test(limpia)) {
    throw new TareaInputError('el link tiene que empezar con http:// o https://');
  }
  try {
    const row = await q1<LinkRow>(
      `INSERT INTO tarea_links (tarea_id, url, etiqueta, posicion)
       VALUES ($1, $2, $3,
               COALESCE((SELECT max(posicion) + 10 FROM tarea_links WHERE tarea_id = $1), 10))
       RETURNING id, url, etiqueta, posicion`,
      [tareaId, limpia, etiqueta ?? null],
    );
    return toLink(row!);
  } catch (err) {
    throw tareaErrorMessage(err);
  }
}

export async function borrarLink(id: number): Promise<void> {
  await q(`DELETE FROM tarea_links WHERE id = $1`, [id]);
}

// ─── Comentarios ────────────────────────────────────────────────────────────

/**
 * Comenta una tarjeta. Cualquiera puede comentar en cualquier tarjeta (esa regla
 * la fija el route, T05 §4). Devuelve el comentario con el nombre del autor ya
 * resuelto, para que la UI no tenga que hacer un segundo fetch.
 */
export async function comentar(
  tareaId: number,
  usuarioId: number,
  cuerpo: string,
): Promise<TareaComentario> {
  const limpio = cuerpo.trim();
  if (limpio.length === 0) {
    throw new TareaInputError('el comentario no puede estar vacío');
  }
  try {
    const row = await q1<ComentarioRow>(
      `WITH nuevo AS (
         INSERT INTO tarea_comentarios (tarea_id, usuario_id, cuerpo)
         VALUES ($1, $2, $3)
         RETURNING id, usuario_id, cuerpo, created_at
       )
       SELECT n.id, n.usuario_id, u.nombre AS usuario_nombre, n.cuerpo,
              to_char(n.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at
         FROM nuevo n JOIN usuarios u ON u.id = n.usuario_id`,
      [tareaId, usuarioId, limpio],
    );
    return toComentario(row!);
  } catch (err) {
    throw tareaErrorMessage(err);
  }
}

// ─── El cron ──────────────────────────────────────────────────────────────

/**
 * Lo que corre el cron de T07: archiva lo que lleva más de `diasDeGracia` días en
 * 'hecho'. Devuelve cuántas archivó (el cron lo loguea; un cron que no dice
 * cuántas tocó no se puede auditar).
 *
 *  · El default es 2 días, y es un PARÁMETRO y no una constante embutida: el test
 *    necesita poder pasar 0 para no esperar dos días.
 *  · make_interval(days => $1) y NO interval '$1 days': lo segundo no compila (un
 *    placeholder no se interpola dentro de un literal de intervalo), y resolverlo
 *    con concatenación de strings es justo lo que §9.3 prohíbe.
 *  · Idempotente por `archivada_at IS NULL`: correrlo dos veces el mismo día
 *    archiva 0 la segunda.
 *
 * Se usa `getPool().query` directo y no el helper `q()` de lib/db.ts porque `q()`
 * devuelve `rows` y acá hace falta `rowCount`: el conteo de filas afectadas es el
 * valor de retorno. Agregar un helper a lib/db.ts sería tocar un archivo de otra
 * task.
 */
export async function archivarHechasViejas(diasDeGracia = 2): Promise<number> {
  const res = await getPool().query(
    `UPDATE tareas SET archivada_at = now()
      WHERE archivada_at IS NULL
        AND hecha_at IS NOT NULL
        AND hecha_at < now() - make_interval(days => $1)`,
    [diasDeGracia],
  );
  return res.rowCount ?? 0;
}
