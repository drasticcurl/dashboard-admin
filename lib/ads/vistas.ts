/**
 * Vista y Repo_Vistas (task 5.1 de gestion-campanas-anuncios): esquema zod,
 * parseo y resolución de la configuración guardada de columnas. Sin `pg` (el
 * storage lo hace el Endpoint_Vistas sobre `settings.ads_vistas`, migración 018
 * §5); este módulo es la parte pura que comparten el cliente y el servidor.
 *
 * Cuatro decisiones de forma (design §5):
 * 1. El orden del array `columnas` ES el orden de izquierda a derecha: no hay
 *    campo `posicion` que se pueda desincronizar del array.
 * 2. `porDefecto` es un campo ÚNICO del repo, no una marca por Vista: "como
 *    máximo una Vista_Por_Defecto" (R3 c7) es irrepresentable de otra forma.
 * 3. La identidad es un `id` UUID, no el nombre: renombrar no toca `porDefecto`.
 * 4. `null` (nunca se guardó) y `{"v":1,"vistas":[],"porDefecto":null}` (se
 *    guardó sin ninguna Vista) son DOS ESTADOS DISTINTOS: el primero dispara el
 *    fallback de R3 c9; el segundo se respeta.
 */

import { z } from 'zod';
import {
  CATALOGO_METRICAS,
  CLAVES_FIJAS,
  columnasParaRender,
  type ColumnaVisible,
  type EntradaCatalogo,
} from './catalogo';
import type { ClaveOrden } from './tipos';
import { ORDEN_DEFAULT } from './orden';

export const MAX_VISTAS = 50; // R3 c3
export const VERSION_VISTAS = 1;

export const ANCHO_MIN = 48;
export const ANCHO_MAX = 640;

export type Orden = { clave: ClaveOrden; dir: 'asc' | 'desc' };

export type Vista = {
  id: string;
  /** 1 a 60 caracteres visibles, sin saltos de línea (R3 c12). */
  nombre: string;
  /** Orden = izquierda a derecha. Incluye las dos Columna_Fija (R2 c4). */
  columnas: ColumnaVisible[];
  orden: Orden;
};

export type RepoVistas = {
  v: typeof VERSION_VISTAS;
  vistas: Vista[];
  porDefecto: string | null;
};

// ─── Esquemas ────────────────────────────────────────────────────────────────

const CLAVES_CATALOGO = CATALOGO_METRICAS.map((e) => e.clave) as [
  (typeof CATALOGO_METRICAS)[number]['clave'],
  ...(typeof CATALOGO_METRICAS)[number]['clave'][],
];

const CLAVES_ORDEN = CATALOGO_METRICAS.filter((e) => e.ordenable).map(
  (e) => e.clave,
) as [ClaveOrden, ...ClaveOrden[]];

const claveSchema = z.enum(CLAVES_CATALOGO); // rechaza claves ajenas (R3 c4)
const claveOrdenSchema = z.enum(CLAVES_ORDEN);

function sinClavesRepetidas(columnas: readonly { clave: string }[]): boolean {
  return new Set(columnas.map((c) => c.clave)).size === columnas.length;
}

function incluyeColumnasFijas(columnas: readonly { clave: string }[]): boolean {
  return CLAVES_FIJAS.every((fija) => columnas.some((c) => c.clave === fija));
}

export const vistaSchema = z
  .object({
    id: z.string().uuid(),
    nombre: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length >= 1 && s.length <= 60)
      .refine((s) => !/[\r\n]/.test(s)),
    columnas: z
      .array(
        z.object({
          clave: claveSchema,
          ancho: z.number().int().min(ANCHO_MIN).max(ANCHO_MAX), // 48..640 (R3 c4)
        }),
      )
      .min(1),
    orden: z.object({ clave: claveOrdenSchema, dir: z.enum(['asc', 'desc']) }),
  })
  .refine((v) => sinClavesRepetidas(v.columnas), { message: 'claves de columna repetidas' })
  .refine((v) => incluyeColumnasFijas(v.columnas), {
    message: 'faltan las columnas fijas seleccion y nombre',
  });

function nombresUnicosSinDistinguirCaso(vistas: readonly Vista[]): boolean {
  const vistos = new Set<string>();
  for (const v of vistas) {
    const k = v.nombre.trim().toLowerCase();
    if (vistos.has(k)) return false;
    vistos.add(k);
  }
  return true;
}

export const repoVistasSchema = z
  .object({
    v: z.literal(VERSION_VISTAS),
    vistas: z.array(vistaSchema).max(MAX_VISTAS),
    porDefecto: z.string().uuid().nullable(),
  })
  .refine(
    (r) => r.porDefecto === null || r.vistas.some((v) => v.id === r.porDefecto),
    { message: 'porDefecto no referencia ninguna Vista existente' },
  )
  .refine((r) => nombresUnicosSinDistinguirCaso(r.vistas), {
    message: 'nombres de Vista repetidos',
  });

// ─── Parseo y resolución ─────────────────────────────────────────────────────

/**
 * Nunca tira. Versión desconocida, basura o `null` → `null`: el llamador aplica
 * el fallback de R3 c9 y avisa (R3 c16). `{"v":1,"vistas":[],"porDefecto":null}`
 * es un repo válido y NO es null: "se guardó sin ninguna Vista" se respeta.
 */
export function parseRepoVistas(raw: unknown): RepoVistas | null {
  if (raw === null || raw === undefined) return null;
  const parsed = repoVistasSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Cruza una Vista con el catálogo vigente (R3 c10, R5 c11):
 *   - descarta las claves que el catálogo ya no declara y devuelve cuáles
 *     (para que la UI avise cuántas ignoró), conservando el orden relativo y
 *     los anchos de las que quedan;
 *   - acota cada ancho al rango 48..640;
 *   - fuerza las dos Columna_Fija a las dos posiciones de más a la izquierda;
 *   - si el Orden_Tabla guardado nombra una clave que ya no es ordenable,
 *     cae al orden por defecto (gastos descendente).
 * NO modifica la Vista guardada: el Repo_Vistas queda tal cual hasta que el
 * usuario la sobrescriba.
 */
export function resolverVista(
  vista: Vista,
  catalogo: readonly EntradaCatalogo[] = CATALOGO_METRICAS,
): { columnas: ColumnaVisible[]; orden: Orden; ignoradas: string[] } {
  const conocidas = new Set<string>(catalogo.map((e) => e.clave));
  const ignoradas: string[] = [];
  const validas: ColumnaVisible[] = [];
  for (const c of vista.columnas) {
    if (!conocidas.has(c.clave)) {
      ignoradas.push(c.clave);
      continue;
    }
    validas.push({
      clave: c.clave,
      ancho: Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, c.ancho)),
    });
  }
  const columnas = columnasParaRender(validas, catalogo);

  const ordenable = catalogo.find((e) => e.clave === vista.orden.clave)?.ordenable === true;
  const orden: Orden = ordenable
    ? vista.orden
    : { clave: ORDEN_DEFAULT.clave, dir: ORDEN_DEFAULT.dir };

  return { columnas, orden, ignoradas };
}

/**
 * Alimenta la marca de cambios sin guardar (R3 c13). El Orden_Tabla es parte
 * del estado. Con `guardada === null` (no hay Vista aplicada) compara contra el
 * conjunto base de las doce columnas de R2 c2 en el orden del catálogo.
 */
export function hayCambios(
  actual: readonly ColumnaVisible[],
  orden: Orden,
  guardada: Vista | null,
): boolean {
  if (guardada === null) {
    const base = columnasParaRender(
      CATALOGO_METRICAS.filter((e) => e.base).map((e) => ({
        clave: e.clave,
        ancho: e.clave === 'nombre' ? 280 : 48,
      })),
    );
    const mismasClaves =
      actual.length === base.length && actual.every((c, i) => c.clave === base[i]!.clave);
    const mismoOrden = orden.clave === ORDEN_DEFAULT.clave && orden.dir === ORDEN_DEFAULT.dir;
    return !mismasClaves || !mismoOrden;
  }

  const { columnas, orden: ordenGuardado } = resolverVista(guardada);
  const mismasColumnas =
    actual.length === columnas.length &&
    actual.every(
      (c, i) => c.clave === columnas[i]!.clave && c.ancho === columnas[i]!.ancho,
    );
  const mismoOrden = orden.clave === ordenGuardado.clave && orden.dir === ordenGuardado.dir;
  return !mismasColumnas || !mismoOrden;
}
