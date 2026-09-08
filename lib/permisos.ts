/**
 * `lib/permisos.ts` — la única fuente de verdad de QUÉ puede ver quién.
 *
 * CONGELADO (plan §4). T03, T04, T05 y T06 lo importan y nadie más lo modifica:
 * es lo que permite que las tres tasks de la ola 2 se escriban al mismo tiempo.
 *
 * El permiso se lee de la BASE en cada request (D3), no viaja en la cookie: así
 * apagarle una pestaña a alguien tiene efecto en el request siguiente, no
 * cuando se le venza la sesión. El costo es que el middleware (Edge, sin base)
 * no puede bloquear por permiso; sólo valida firma y expiración. El bloqueo por
 * permiso lo hacen el layout de cada sección y el `guard()` de las routes, los
 * dos en Node.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';
import { q } from '@/lib/db';
import {
  PANEL_COOKIE_NAME,
  verifySessionToken,
  verifyPassword,
} from '@/lib/auth';

// ─── Las 8 pestañas ─────────────────────────────────────────────────────────

/** Las 8 pestañas del header. El vocabulario tiene que ser IGUAL al CHECK
 *  `usuario_secciones_valida` de la 030 — hay un test que lo compara. */
export const SECCIONES = [
  'resumen',
  'embudo',
  'ventas',
  'anuncios',
  'finanzas',
  'leads',
  'config',
  'tareas',
] as const;
export type Seccion = (typeof SECCIONES)[number];

/** Lo que el layout y las routes necesitan saber del que entró. */
export type Sesion = {
  usuarioId: number;
  usuario: string;
  nombre: string;
  esAdmin: boolean;
  debeCambiarClave: boolean;
  /** Las 8 si es admin (D11). Vacío si no se le otorgó nada. */
  secciones: readonly Seccion[];
  /** true = entró por el fallback de DASHBOARD_PASSWORD con la tabla vacía (D10). */
  esFallback: boolean;
};

// ─── sesionActual: lee la cookie, valida la firma y CONSULTA LA BASE ─────────

type UsuarioRow = {
  id: number;
  usuario: string;
  nombre: string;
  es_admin: boolean;
  debe_cambiar_clave: boolean;
  secciones: string[];
};

// Una sola consulta con array_agg, no dos: el layout corre en CADA pantalla del
// panel y ya hace un Promise.all de dos queries; una tercera en serie se nota.
//
// LEFT JOIN y no JOIN: un usuario SIN ninguna sección otorgada tiene que
// devolver una sesión con la lista vacía, no null. "No tiene permisos"
// (→ /sin-acceso) y "no existe" (→ login) son cosas distintas; con un JOIN a
// secas el usuario recién creado desaparecería.
//
// AND u.activo: desactivar a alguien le corta el acceso en el request siguiente
// (D3), que es lo que hace instantáneo el switch.
const SESION_SQL = `
  SELECT u.id, u.usuario, u.nombre, u.es_admin, u.debe_cambiar_clave,
         COALESCE(array_agg(s.seccion) FILTER (WHERE s.seccion IS NOT NULL), '{}') AS secciones
    FROM usuarios u
    LEFT JOIN usuario_secciones s ON s.usuario_id = u.id
   WHERE u.id = $1 AND u.activo
   GROUP BY u.id`;

const CONTAR_USUARIOS_SQL = `SELECT count(*)::int AS n FROM usuarios`;

/**
 * El núcleo de `sesionActual()`: a partir de un token YA EXTRAÍDO (no de dónde
 * salió), valida la firma y CONSULTA LA BASE. `null` si no hay sesión usable.
 *
 * Se separa de `sesionActual()` por una razón de testabilidad, no de diseño:
 * `sesionActual()` lee `cookies()` de `next/headers`, que sólo resuelve dentro
 * del contexto de request real de Next (un route handler o un server
 * component ejecutándose de verdad). Eso es correcto en producción, pero rompe
 * a los tests que invocan un route handler directamente en Node sin ese
 * contexto — y son decenas, preexistentes a este módulo, que mockeaban
 * `isAuthenticated` de `lib/auth.ts` (el mecanismo viejo). `guardSeccion(req)`
 * YA recibe el `NextRequest`, así que puede leer `req.cookies` sin pasar por
 * `next/headers`: llama a esta función en vez de a `sesionActual()`, y el
 * comportamiento es idéntico porque la lógica vive en un solo lugar.
 */
async function sesionDesdeToken(token: string | undefined): Promise<Sesion | null> {
  const parsed = verifySessionToken(token);
  if (!parsed) return null;

  // usuarioId 0 es el fallback de D10 (tabla vacía): no existe en `usuarios`, así
  // que no tiene sentido consultarlo. Su sesión la arma quien firmó el token del
  // fallback; acá se reconstruye si la cookie del fallback sigue vigente.
  if (parsed.usuarioId === 0) {
    // El fallback SÓLO vale con la tabla vacía: si ya hay una fila, este camino
    // no se toma más (D10). Se apaga solo.
    const { n } = (await q<{ n: number }>(CONTAR_USUARIOS_SQL))[0] ?? { n: 0 };
    if (n > 0) return null;
    return sesionFallback();
  }

  const row = (await q<UsuarioRow>(SESION_SQL, [parsed.usuarioId]))[0];
  if (!row) return null;

  return filaASesion(row);
}

/**
 * Lee la cookie, valida la firma y CONSULTA LA BASE. `null` si no hay sesión
 * usable (sin cookie, firma inválida, vencida, o usuario inactivo/borrado).
 *
 * El fallback de D10 (tabla `usuarios` VACÍA → DASHBOARD_PASSWORD vale como
 * admin) NO se resuelve acá: `sesionActual()` sólo sabe leer una cookie con
 * identidad. El fallback lo arma `app/page.tsx` (T04) llamando a
 * `verifyPassword` en la rama de la tabla vacía y construyendo la
 * `sesionFallback()` de abajo. Se separa porque el fallback nace de un POST de
 * login, no de una cookie ya firmada.
 *
 * Para server components y layouts (que no tienen un `NextRequest` a mano).
 * Las routes de API usan `guardSeccion(req)`, que resuelve lo mismo desde
 * `req.cookies` sin pasar por `next/headers`.
 */
export async function sesionActual(): Promise<Sesion | null> {
  const token = cookies().get(PANEL_COOKIE_NAME)?.value;
  return sesionDesdeToken(token);
}

function filaASesion(row: UsuarioRow): Sesion {
  // Si es admin, las 8 secciones IGNORANDO lo que haya en la tabla (D11): un
  // admin no puede autoencerrarse fuera de Config.
  const secciones: readonly Seccion[] = row.es_admin
    ? SECCIONES
    : row.secciones.filter((s): s is Seccion => (SECCIONES as readonly string[]).includes(s));
  return {
    usuarioId: row.id,
    usuario: row.usuario,
    nombre: row.nombre,
    esAdmin: row.es_admin,
    debeCambiarClave: row.debe_cambiar_clave,
    secciones,
    esFallback: false,
  };
}

/**
 * La sesión del fallback de D10.
 *
 * Con la tabla usuarios VACÍA, DASHBOARD_PASSWORD sigue valiendo y esa sesión es
 * admin. Es lo que hace que el deploy no deje a nadie afuera entre la migración y
 * el `npm run usuarios:seed`, en las DOS instancias.
 *
 * Sólo con la tabla vacía. NO es "si la clave no matchea a ningún usuario, probá
 * con la vieja" — eso sería una puerta de atrás permanente. Se apaga solo: en
 * cuanto hay una fila, este camino no se toma más.
 *
 * `usuarioId: 0` y no -1 ni null: es el valor que T05 pone en `creado_por` como
 * `null` (la columna es nullable justo para esto) y que T06 muestra como "—". Un
 * id negativo se colaría en un `Number.isInteger(id) && id > 0` de alguna
 * validación y se volvería un bug raro. `debeCambiarClave: false` porque el
 * fallback no tiene clave propia que cambiar.
 */
export function sesionFallback(): Sesion {
  return {
    usuarioId: 0,
    usuario: 'admin',
    nombre: 'Administrador',
    esAdmin: true,
    debeCambiarClave: false,
    secciones: SECCIONES,
    esFallback: true,
  };
}

/**
 * ¿Con la tabla `usuarios` vacía? Es la condición que habilita el fallback de
 * D10. La exporta para `app/page.tsx` (T04), que la usa para decidir si acepta
 * DASHBOARD_PASSWORD en el login.
 */
export async function tablaUsuariosVacia(): Promise<boolean> {
  const { n } = (await q<{ n: number }>(CONTAR_USUARIOS_SQL))[0] ?? { n: 0 };
  return n === 0;
}

/**
 * El fallback de D10 desde un intento de login (clave contra DASHBOARD_PASSWORD).
 * `null` si la tabla no está vacía o la clave no matchea. Lo llama `app/page.tsx`.
 */
export async function intentarFallback(clave: string | undefined): Promise<Sesion | null> {
  if (!(await tablaUsuariosVacia())) return null;
  if (!verifyPassword(clave)) return null;
  return sesionFallback();
}

// ─── puedeVer ─────────────────────────────────────────────────────────────

export function puedeVer(sesion: Sesion, seccion: Seccion): boolean {
  // El admin ve todo (D11): `secciones` ya trae las 8, pero el chequeo explícito
  // deja el invariante escrito por si algún día `secciones` llegara vacío por un
  // bug.
  if (sesion.esAdmin) return true;
  return sesion.secciones.includes(seccion);
}

// ─── requerirSeccion (para el layout de cada sección) ───────────────────────

/**
 * Para el layout de cada sección. NO devuelve: redirige.
 *   · sin sesión           → redirect('/')
 *   · debeCambiarClave     → redirect('/cambiar-clave')
 *   · sin permiso          → redirect(<la primera sección que sí puede ver>)
 *   · sin NINGUNA sección  → redirect('/sin-acceso')
 * El redirect a la primera permitida y no un 403: alguien que entra por un link
 * viejo tiene que caer en una pantalla que sí puede usar, no en un cartel.
 *
 * El orden importa: `debeCambiarClave` se chequea ANTES que el permiso. Si no,
 * alguien con la clave por defecto y sin secciones va a /sin-acceso y nunca
 * puede cambiarla.
 */
export async function requerirSeccion(seccion: Seccion): Promise<Sesion> {
  const sesion = await sesionActual();
  if (!sesion) redirect('/');
  if (sesion.debeCambiarClave) redirect('/cambiar-clave');
  if (puedeVer(sesion, seccion)) return sesion;

  // Sin permiso a esta sección: mandarlo a la primera que SÍ puede ver, en el
  // orden de SECCIONES (el orden del header).
  const primera = SECCIONES.find((s) => puedeVer(sesion, s));
  if (primera) redirect(`/${primera}`);
  redirect('/sin-acceso');
}

// ─── MAPA_API (D5) ──────────────────────────────────────────────────────────

/**
 * Mapa EXPLÍCITO de ruta de API a lo que hace falta para llamarla (D5).
 * Las claves son pathnames exactos, sin barra final.
 *
 * NO es una regla por prefijo: tres rutas viven bajo un prefijo que no es su
 * sección (las tres marcadas abajo). El default de una ruta que NO está acá es
 * NEGAR (lo hace `guardSeccion`), y T03 tiene un test que enumera las route.ts
 * de app/api y falla si aparece una sin mapear: "me olvidé de una" tiene que
 * romper el build, no producir un 403 en producción.
 *
 * Con `readonly Seccion[]`, el permiso pasa si el usuario tiene CUALQUIERA de
 * las de la lista.
 */
export const MAPA_API: Record<string, readonly Seccion[] | 'admin' | 'publica'> = {
  // ── Datos de cada pestaña ────────────────────────────────────────────────
  '/api/data/overview': ['resumen'],
  '/api/data/funnel': ['embudo'],
  '/api/data/pitch': ['embudo'],
  '/api/data/sales': ['ventas'],
  '/api/data/leads': ['leads'],
  '/api/data/ads': ['anuncios'],
  '/api/data/ads/historial': ['anuncios'],

  // ── Acciones de anuncios ─────────────────────────────────────────────────
  '/api/ads/acciones': ['anuncios'],
  '/api/ads/interruptores': ['anuncios'],
  '/api/ads/reglas': ['anuncios'],
  '/api/ads/reglas/csv': ['anuncios'],

  // ── Finanzas ─────────────────────────────────────────────────────────────
  '/api/finanzas/cuentas': ['finanzas'],
  '/api/finanzas/movimientos': ['finanzas'],
  '/api/finanzas/pagos-programados': ['finanzas'],
  '/api/finanzas/pagos-programados/ejecutar-ahora': ['finanzas'],
  '/api/finanzas/saldos': ['finanzas'],

  // ── Config → sección 'config', una por una, sin comodines ────────────────
  '/api/config/ads': ['config'],
  '/api/config/commissions': ['config'],
  '/api/config/settings': ['config'],
  '/api/config/products': ['config'],
  '/api/config/stages': ['config'],
  '/api/config/steps': ['config'],
  '/api/config/fx': ['config'],
  '/api/config/shops': ['config'],
  '/api/config/system': ['config'],
  '/api/config/funnels': ['config'],
  '/api/config/funnels/ingest-key': ['config'],

  // ── Tareas (las escribe T05; el mapa las declara desde ya) ────────────────
  '/api/tareas': ['tareas'],
  '/api/tareas/mover': ['tareas'],
  '/api/tareas/links': ['tareas'],
  '/api/tareas/comentarios': ['tareas'],

  // ── LAS TRES QUE UN MAPA POR PREFIJO SE COMERÍA ───────────────────────────
  // Lo llama components/WidgetGrid.tsx:408, que se monta en Resumen y en Ventas.
  // Con 'config' acá, nahuel mueve un widget en Resumen y el POST le da 403 en un
  // fetch que nadie mira: el widget vuelve solo a su lugar y parece un bug de la UI.
  '/api/config/ui-layout': ['resumen', 'ventas'],
  // Lo llama app/(panel)/anuncios/GestorAnuncios.tsx:1148. Vive bajo /api/config
  // por dónde guarda (settings.ads_vistas), no por qué pantalla lo usa.
  '/api/config/vistas-ads': ['anuncios'],
  // Lo llama components/PanelInsight.tsx:75, montado en Resumen y en Finanzas.
  '/api/ia/insight': ['resumen', 'finanzas'],

  // ── Sólo admin ────────────────────────────────────────────────────────────
  '/api/usuarios': 'admin',
  '/api/usuarios/clave': 'admin', // T04 le agrega la excepción del propio usuario

  // ── Públicas: fuera del matcher del middleware, con su propia auth ────────
  '/api/ingest': 'publica',
  '/api/webhooks/shopify': 'publica',
  '/api/webhooks/hotmart': 'publica',
};

// ─── guardSeccion (el reemplazo de guard(req) para las routes) ──────────────

type RespuestaError = { respuesta: NextResponse };

function json401(): RespuestaError {
  return {
    respuesta: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
  };
}

function json403(error: 'forbidden' | 'clave_pendiente'): RespuestaError {
  return { respuesta: NextResponse.json({ ok: false, error }, { status: 403 }) };
}

/**
 * El reemplazo de `guard(req)` para las routes. Devuelve `{ sesion }` si puede
 * pasar, o `{ respuesta }` con el error ya armado:
 *   · 401 unauthorized       — sin sesión.
 *   · 403 clave_pendiente    — debe cambiar la clave (se chequea ANTES del permiso).
 *   · 403 forbidden          — sin permiso, O la ruta NO está en MAPA_API (falla
 *                              cerrado: una ruta sin mapear se niega).
 *
 * Las rutas 'publica' del mapa no deberían llegar acá (están fuera del matcher
 * del middleware y tienen su propia auth); si una llega, se niega igual, porque
 * este guard es para rutas del panel.
 */
export async function guardSeccion(
  req: NextRequest,
): Promise<{ sesion: Sesion } | { respuesta: NextResponse }> {
  // Lee la cookie DEL REQUEST, no de `cookies()` de `next/headers`: éste ya
  // trae el `NextRequest`, así que no depende del contexto global de Next y
  // sigue siendo testeable con un route handler invocado directo en Node (ver
  // el docblock de `sesionDesdeToken`).
  const token = req.cookies.get(PANEL_COOKIE_NAME)?.value;
  const sesion = await sesionDesdeToken(token);
  if (!sesion) return json401();
  // La clave pendiente se chequea ANTES que el permiso: una sesión en ese estado
  // no sirve para nada que no sea cambiar la clave (D8).
  if (sesion.debeCambiarClave) return json403('clave_pendiente');

  const pathname = req.nextUrl.pathname;
  const requerido = MAPA_API[pathname];

  // Default NEGAR: ruta no mapeada → 403 (D5). No hay comodines.
  if (requerido === undefined) return json403('forbidden');
  // Una ruta pública no se sirve desde este guard (es del panel): negar.
  if (requerido === 'publica') return json403('forbidden');

  if (requerido === 'admin') {
    if (sesion.esAdmin) return { sesion };
    return json403('forbidden');
  }

  // readonly Seccion[]: pasa si tiene CUALQUIERA de las de la lista.
  if (requerido.some((s) => puedeVer(sesion, s))) return { sesion };
  return json403('forbidden');
}
