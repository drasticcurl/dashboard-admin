/**
 * Capa de datos de usuarios y sus permisos por sección (migración 030).
 * Plan `tasks/usuarios-y-tareas/` §6 del T01, contrato de firmas congelado.
 *
 * El molde es `lib/queries/saldo.ts`: filas tipadas, mapeo snake_case → camelCase
 * a mano en un `.map()` explícito, y una clase de error de dominio
 * (`UsuarioInputError`) que traduce los SQLSTATE de Postgres a castellano ACÁ, en
 * la capa de queries, no en el route.
 *
 * Dos invariantes de seguridad que este archivo garantiza:
 *  1. `claveHash` sale SÓLO de `usuarioPorNombre` (lo único que la necesita: el
 *     login). Un hash que viaja al cliente en un JSON es un hash ofrecido para
 *     romper offline.
 *  2. Todo va parametrizado ($1, $2), nunca concatenado.
 */

import { q, q1, tx } from '@/lib/db';
import { SECCIONES, type Seccion } from '@/lib/permisos';

// ─── Tipo ─────────────────────────────────────────────────────────────────

export type Usuario = {
  id: number;
  usuario: string;
  nombre: string;
  esAdmin: boolean;
  debeCambiarClave: boolean;
  activo: boolean;
  /** ISO, o null si nunca entró. */
  ultimoLoginAt: string | null;
  /** Las secciones OTORGADAS (las filas de usuario_secciones). El admin puede
   *  tener la lista vacía acá: su "ve todo" lo resuelve `es_admin`, no filas. */
  secciones: Seccion[];
};

/**
 * Un pedido mal armado, no una falla del servidor. Existe para que los routes
 * puedan contestar 400 con un mensaje legible sin comparar el texto del error,
 * igual que `SaldoInputError` en `saldo.ts`.
 */
export class UsuarioInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsuarioInputError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type UsuarioRow = {
  id: number;
  usuario: string;
  nombre: string;
  es_admin: boolean;
  debe_cambiar_clave: boolean;
  activo: boolean;
  ultimo_login_at: Date | null;
  secciones: string[];
};

// array_agg con FILTER + COALESCE al array vacío: un usuario sin secciones trae
// '{}' y no una fila fantasma con NULL (el LEFT JOIN de la sección lo requiere).
const COLS = `
  u.id, u.usuario, u.nombre, u.es_admin, u.debe_cambiar_clave, u.activo,
  u.ultimo_login_at,
  COALESCE(array_agg(s.seccion) FILTER (WHERE s.seccion IS NOT NULL), '{}') AS secciones`;

const FROM_GROUP = `
  FROM usuarios u
  LEFT JOIN usuario_secciones s ON s.usuario_id = u.id`;

function toUsuario(r: UsuarioRow): Usuario {
  return {
    id: Number(r.id),
    usuario: r.usuario,
    nombre: r.nombre,
    esAdmin: r.es_admin,
    debeCambiarClave: r.debe_cambiar_clave,
    activo: r.activo,
    ultimoLoginAt: r.ultimo_login_at ? r.ultimo_login_at.toISOString() : null,
    // Sólo las que son parte del vocabulario vigente: una sección que quedara
    // en la tabla y no esté en SECCIONES no debería salir a la UI.
    secciones: r.secciones.filter((x): x is Seccion => (SECCIONES as readonly string[]).includes(x)),
  };
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/**
 * Traduce el 23505 del índice `usuarios_usuario_uq` a castellano. El SQLSTATE no
 * le dice nada a nadie. El 23514 (CHECK) cae en un mensaje genérico de datos
 * inválidos: el nombre vacío, la mayúscula o el espacio ya los normaliza el
 * route, así que si llega hasta acá es un caso de borde.
 */
function usuarioErrorMessage(err: unknown): Error {
  const code = codeOf(err);
  if (code === '23505') {
    return new UsuarioInputError('ya existe un usuario con ese nombre');
  }
  if (code === '23514') {
    return new UsuarioInputError(
      'datos inválidos: el usuario tiene que ir en minúsculas y sin espacios, y ni el usuario ni el nombre pueden estar vacíos',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ─── Lectura ────────────────────────────────────────────────────────────────

/** Todos los usuarios, activos e inactivos, para la pantalla de administración. */
export async function listarUsuarios(): Promise<Usuario[]> {
  const rows = await q<UsuarioRow>(
    `SELECT ${COLS} ${FROM_GROUP} GROUP BY u.id ORDER BY u.id`,
  );
  return rows.map(toUsuario);
}

/**
 * Busca por usuario (normalizado) entre TODOS, y devuelve el hash. Es lo único
 * que expone `claveHash`, y sólo lo usa el login del server. No filtra por
 * `activo`: el login tiene que poder distinguir "usuario inactivo" de "no
 * existe" si algún día hace falta, aunque hoy los dos den el mismo mensaje
 * genérico.
 */
export async function usuarioPorNombre(
  usuario: string,
): Promise<(Usuario & { claveHash: string }) | null> {
  const row = await q1<UsuarioRow & { clave_hash: string }>(
    `SELECT ${COLS}, u.clave_hash
       ${FROM_GROUP}
      WHERE lower(btrim(u.usuario)) = lower(btrim($1))
      GROUP BY u.id`,
    [usuario],
  );
  if (!row) return null;
  return { ...toUsuario(row), claveHash: row.clave_hash };
}

export async function usuarioPorId(id: number): Promise<Usuario | null> {
  const row = await q1<UsuarioRow>(
    `SELECT ${COLS} ${FROM_GROUP} WHERE u.id = $1 GROUP BY u.id`,
    [id],
  );
  return row ? toUsuario(row) : null;
}

export async function contarUsuarios(): Promise<number> {
  const row = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM usuarios`);
  return Number(row!.n);
}

// ─── Escritura ────────────────────────────────────────────────────────────────

/**
 * Crea un usuario con su hash ya calculado (el hasheo vive en `lib/auth.ts`, no
 * acá: esta capa no conoce claves en claro). El nombre de usuario se guarda
 * normalizado (minúsculas, sin espacios de borde) para que el CHECK de la 030 no
 * lo rechace; el índice único traduce el choque a `UsuarioInputError`.
 */
export async function crearUsuario(u: {
  usuario: string;
  nombre: string;
  claveHash: string;
  esAdmin?: boolean;
  debeCambiarClave?: boolean;
}): Promise<Usuario> {
  try {
    const row = await q1<UsuarioRow>(
      `WITH nuevo AS (
         INSERT INTO usuarios (usuario, nombre, clave_hash, es_admin, debe_cambiar_clave)
         VALUES (lower(btrim($1)), btrim($2), $3, COALESCE($4, false), COALESCE($5, true))
         RETURNING id, usuario, nombre, es_admin, debe_cambiar_clave, activo, ultimo_login_at
       )
       SELECT n.id, n.usuario, n.nombre, n.es_admin, n.debe_cambiar_clave, n.activo,
              n.ultimo_login_at, '{}'::text[] AS secciones
         FROM nuevo n`,
      [u.usuario, u.nombre, u.claveHash, u.esAdmin ?? null, u.debeCambiarClave ?? null],
    );
    return toUsuario(row!);
  } catch (err) {
    throw usuarioErrorMessage(err);
  }
}

/**
 * Actualiza nombre / es_admin / activo de un usuario. Los tres campos son
 * opcionales: `undefined` = no lo toques.
 *
 * NO puede dejar al panel sin admin activo. No se puede expresar con un CHECK (es
 * una condición entre filas), así que va acá, DENTRO de la misma transacción que
 * el UPDATE: dos pedidos simultáneos quitándose el admin, sin el bloqueo, lo
 * pasan los dos y el panel queda sin nadie que pueda entrar a Config.
 */
export async function actualizarUsuario(
  id: number,
  cambios: { nombre?: string; esAdmin?: boolean; activo?: boolean },
): Promise<Usuario> {
  try {
    return await tx(async (c) => {
      const actualRes = await c.query<UsuarioRow>(
        `SELECT u.id, u.usuario, u.nombre, u.es_admin, u.debe_cambiar_clave, u.activo,
                u.ultimo_login_at, '{}'::text[] AS secciones
           FROM usuarios u WHERE u.id = $1 FOR UPDATE`,
        [id],
      );
      const actual = actualRes.rows[0];
      if (!actual) throw new UsuarioInputError('ese usuario no existe');

      const nombre = cambios.nombre !== undefined ? cambios.nombre.trim() : actual.nombre;
      const esAdmin = cambios.esAdmin !== undefined ? cambios.esAdmin : actual.es_admin;
      const activo = cambios.activo !== undefined ? cambios.activo : actual.activo;

      // ¿Este cambio deja al panel sin ningún admin activo? Pasa si el usuario ERA
      // admin activo y queda sin serlo (le sacan el admin o lo desactivan).
      const eraAdminActivo = actual.es_admin && actual.activo;
      const seguiraAdminActivo = esAdmin && activo;
      if (eraAdminActivo && !seguiraAdminActivo) {
        // Cuenta los OTROS admins activos dentro de la misma tx (con el FOR UPDATE
        // de arriba tomado sobre esta fila, dos pedidos no pueden pasar los dos).
        const otrosRes = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM usuarios
            WHERE es_admin AND activo AND id <> $1`,
          [id],
        );
        if (Number(otrosRes.rows[0]!.n) === 0) {
          throw new UsuarioInputError(
            'no se puede: es el único admin activo, el panel quedaría sin nadie que administre',
          );
        }
      }

      const updRes = await c.query<UsuarioRow>(
        `UPDATE usuarios SET nombre = $2, es_admin = $3, activo = $4
          WHERE id = $1
          RETURNING id, usuario, nombre, es_admin, debe_cambiar_clave, activo,
                    ultimo_login_at, '{}'::text[] AS secciones`,
        [id, nombre, esAdmin, activo],
      );
      // Las secciones no se tocan acá; se releen con la query completa para
      // devolver el estado real.
      const conSecciones = await c.query<UsuarioRow>(
        `SELECT ${COLS} ${FROM_GROUP} WHERE u.id = $1 GROUP BY u.id`,
        [id],
      );
      return toUsuario(conSecciones.rows[0] ?? updRes.rows[0]!);
    });
  } catch (err) {
    if (err instanceof UsuarioInputError) throw err;
    throw usuarioErrorMessage(err);
  }
}

/**
 * Cambia el hash y baja `debe_cambiar_clave` a false: cambiar la clave es
 * justamente lo que saca a la sesión del estado "pendiente". El hasheo vive en
 * `lib/auth.ts`; acá llega ya hasheado.
 */
export async function cambiarClave(id: number, claveHash: string): Promise<void> {
  await q(
    `UPDATE usuarios SET clave_hash = $2, debe_cambiar_clave = false WHERE id = $1`,
    [id, claveHash],
  );
}

/**
 * Reemplazo COMPLETO de las secciones de un usuario (la pantalla manda el estado
 * final de los 8 switches, no un diff): DELETE de las que están e INSERT de las
 * nuevas, dentro de `tx()`.
 *
 * Usa el `c` del callback, NUNCA `q()`: `q()` toma otra conexión del pool y
 * quedaría afuera de la transacción, con la transacción abierta esperando —
 * camino directo a un deadlock.
 */
export async function fijarSecciones(id: number, secciones: Seccion[]): Promise<Usuario> {
  // Dedup y validación contra el vocabulario: una sección repetida rompería el
  // PK compuesto, y una fuera de SECCIONES la rechazaría el CHECK con un 23514.
  const unicas = Array.from(new Set(secciones)).filter((s) =>
    (SECCIONES as readonly string[]).includes(s),
  );
  return tx(async (c) => {
    const existe = await c.query(`SELECT 1 FROM usuarios WHERE id = $1 FOR UPDATE`, [id]);
    if (existe.rows.length === 0) throw new UsuarioInputError('ese usuario no existe');

    await c.query(`DELETE FROM usuario_secciones WHERE usuario_id = $1`, [id]);
    for (const seccion of unicas) {
      await c.query(
        `INSERT INTO usuario_secciones (usuario_id, seccion) VALUES ($1, $2)`,
        [id, seccion],
      );
    }
    const row = await c.query<UsuarioRow>(
      `SELECT ${COLS} ${FROM_GROUP} WHERE u.id = $1 GROUP BY u.id`,
      [id],
    );
    return toUsuario(row.rows[0]!);
  });
}

/** Marca el último login (lo llama el server cuando el login sale bien). */
export async function marcarLogin(id: number): Promise<void> {
  await q(`UPDATE usuarios SET ultimo_login_at = now() WHERE id = $1`, [id]);
}
