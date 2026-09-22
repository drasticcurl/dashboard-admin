/**
 * Capa de datos del tracker de creativos (migración 034).
 *
 * El molde es `lib/queries/tareas.ts`: filas tipadas, mapeo snake_case →
 * camelCase a mano en `.map()`, y una clase de error de dominio
 * (`CreativoInputError`) que traduce los SQLSTATE de Postgres a castellano ACÁ,
 * no en el route. Es más chico que tareas.ts porque acá no hay tablero, ni
 * sub-recursos (links/comentarios), ni un dueño que restrinja quién edita —
 * cualquiera con la sección puede editar o borrar cualquier fila (ver el
 * docblock de la 034).
 */

import { q, q1 } from '@/lib/db';

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type Rendimiento = 'alto' | 'medio' | 'bajo';
export const RENDIMIENTOS: readonly Rendimiento[] = ['alto', 'medio', 'bajo'] as const;

export type Creativo = {
  id: number;
  nombre: string;
  link: string;
  rendimiento: Rendimiento;
  creadoPor: number | null;
  creadoPorNombre: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Un pedido mal armado, no una falla del servidor. Existe para que el route
 * pueda contestar 400 con un mensaje legible sin comparar el texto del error,
 * igual que `TareaInputError` en `tareas.ts`.
 */
export class CreativoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativoInputError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ISO = (d: Date): string => d.toISOString();

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/**
 * Traduce los SQLSTATE de la 034 a castellano.
 *
 *  · 23514 CHECK: nombre vacío, link sin http(s)://, o rendimiento fuera del
 *    vocabulario alto/medio/bajo.
 *  · 23503 FK: `creado_por` apuntando a un usuario que no existe (no debería
 *    pasar en uso normal: el route lo llena desde la sesión).
 */
function creativoErrorMessage(err: unknown): Error {
  const code = codeOf(err);

  if (code === '23503') {
    return new CreativoInputError('el usuario indicado no existe');
  }
  if (code === '23514') {
    return new CreativoInputError(
      'datos inválidos: el nombre no puede estar vacío, el link tiene que empezar con ' +
        'http:// o https://, y el rendimiento tiene que ser alto, medio o bajo',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ─── Filas crudas y su mapeo ────────────────────────────────────────────────

// `bigserial` llega como string de node-pg (Number() en cada id), igual que en
// tareas.ts.
type CreativoRow = {
  id: number | string;
  nombre: string;
  link: string;
  rendimiento: Rendimiento;
  creado_por: number | string | null;
  creado_por_nombre: string | null;
  created_at: Date;
  updated_at: Date;
};

function toCreativo(r: CreativoRow): Creativo {
  return {
    id: Number(r.id),
    nombre: r.nombre,
    link: r.link,
    rendimiento: r.rendimiento,
    creadoPor: r.creado_por === null ? null : Number(r.creado_por),
    creadoPorNombre: r.creado_por_nombre,
    createdAt: ISO(r.created_at),
    updatedAt: ISO(r.updated_at),
  };
}

// LEFT JOIN y no JOIN: `creado_por` es nullable (ON DELETE SET NULL, y las
// filas creadas por la sesión de fallback de D10 nacen con creado_por NULL) —
// un INNER join perdería esas filas de la lista en vez de mostrarlas con "—".
const SELECT_CREATIVO = `
  SELECT
    c.id, c.nombre, c.link, c.rendimiento,
    c.creado_por, u.nombre AS creado_por_nombre,
    c.created_at, c.updated_at
  FROM creativos c
  LEFT JOIN usuarios u ON u.id = c.creado_por`;

async function creativoPorId(id: number): Promise<Creativo | null> {
  const row = await q1<CreativoRow>(`${SELECT_CREATIVO} WHERE c.id = $1`, [id]);
  return row ? toCreativo(row) : null;
}

/** La lista completa, lo más nuevo primero (mismo orden que el índice
 *  `creativos_created_at_idx` de la 034). */
export async function listarCreativos(): Promise<Creativo[]> {
  const rows = await q<CreativoRow>(`${SELECT_CREATIVO} ORDER BY c.created_at DESC, c.id DESC`);
  return rows.map(toCreativo);
}

// ─── Escritura ──────────────────────────────────────────────────────────────

/**
 * Crea un creativo. `creadoPor` sale de la sesión (null en el fallback de D10,
 * mismo patrón que `crearTarea`).
 */
export async function crearCreativo(
  c: { nombre: string; link: string; rendimiento: Rendimiento },
  creadoPor: number | null,
): Promise<Creativo> {
  const nombre = c.nombre.trim();
  if (nombre.length === 0) {
    throw new CreativoInputError('el nombre no puede estar vacío');
  }
  const link = c.link.trim();
  if (!/^https?:\/\/.+/i.test(link)) {
    throw new CreativoInputError('el link tiene que empezar con http:// o https://');
  }
  try {
    const row = await q1<{ id: string }>(
      `INSERT INTO creativos (nombre, link, rendimiento, creado_por)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [nombre, link, c.rendimiento, creadoPor],
    );
    return (await creativoPorId(Number(row!.id)))!;
  } catch (err) {
    throw creativoErrorMessage(err);
  }
}

/**
 * Edita un creativo. `undefined` = no lo toques, igual que `editarTarea`.
 * Cualquiera con la sección puede editar cualquier fila (no hay dueño, ver el
 * docblock de la 034) — esa decisión la aplica el route al no comprobar
 * `creadoPor` contra la sesión.
 */
export async function editarCreativo(
  id: number,
  cambios: { nombre?: string; link?: string; rendimiento?: Rendimiento },
): Promise<Creativo> {
  const actual = await q1<{ nombre: string; link: string; rendimiento: Rendimiento }>(
    `SELECT nombre, link, rendimiento FROM creativos WHERE id = $1`,
    [id],
  );
  if (!actual) throw new CreativoInputError('ese creativo no existe');

  const nombre = cambios.nombre !== undefined ? cambios.nombre.trim() : actual.nombre;
  if (nombre.length === 0) {
    throw new CreativoInputError('el nombre no puede estar vacío');
  }
  const link = cambios.link !== undefined ? cambios.link.trim() : actual.link;
  if (!/^https?:\/\/.+/i.test(link)) {
    throw new CreativoInputError('el link tiene que empezar con http:// o https://');
  }
  const rendimiento = cambios.rendimiento ?? actual.rendimiento;

  try {
    await q(
      `UPDATE creativos SET nombre = $2, link = $3, rendimiento = $4 WHERE id = $1`,
      [id, nombre, link, rendimiento],
    );
  } catch (err) {
    throw creativoErrorMessage(err);
  }
  const creativo = await creativoPorId(id);
  if (!creativo) throw new CreativoInputError('ese creativo no existe');
  return creativo;
}

export async function borrarCreativo(id: number): Promise<void> {
  await q(`DELETE FROM creativos WHERE id = $1`, [id]);
}
