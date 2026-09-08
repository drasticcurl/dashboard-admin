/**
 * Siembra los usuarios del panel (D9). `npm run usuarios:seed`.
 *
 * Modelo: `scripts/set-ingest-key.ts`. Va en un script y no en la migración 030
 * por dos razones (D9): el admin es distinto por instancia (hilvanapp → lucho,
 * infinix → Ivan) y una migración SQL no lee env vars; y un hash de clave dentro
 * de un archivo commiteado es una credencial en git para siempre.
 *
 *   npm run usuarios:seed                      → sólo el admin (PANEL_ADMIN_USUARIO)
 *   npm run usuarios:seed -- nahuel:Nahuel     → admin + nahuel
 *   PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan npm run usuarios:seed
 *
 * IDEMPOTENTE: si el usuario ya existe, lo saltea y NO le toca la clave. El
 * deploy corre el seed en cada push; si no fuera idempotente, cada deploy le
 * devolvería la clave 123456 a quien ya la cambió.
 *
 * El admin nace con las 8 secciones — que no necesita filas (es_admin implica
 * todo, D11), así que NO se le insertan. Los adicionales nacen SIN ninguna
 * sección: las otorga el admin desde la pantalla. Un usuario nuevo que ve todo
 * es lo contrario de lo que pide este módulo.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPool, q } from '../lib/db';
import { hashearClave } from '../lib/auth';

// scripts/migrate.ts no carga el .env y es una molestia conocida; se hace acá con
// el patrón de lib/queries/reconciliacion.integracion.test.ts:46-48.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

/** La clave inicial de todos. Un riesgo aceptado (D8): la primera pantalla obliga
 *  a cambiarla, y mientras `debe_cambiar_clave = true` la sesión no sirve para
 *  otra cosa. */
const CLAVE_INICIAL = '123456';

type Sembrable = { usuario: string; nombre: string; esAdmin: boolean };

function parsearAdicionales(args: string[]): Sembrable[] {
  return args.map((arg) => {
    const [usuario, nombre] = arg.split(':');
    if (!usuario || !nombre) {
      console.error(`argumento inválido: "${arg}" (se espera usuario:Nombre, ej. nahuel:Nahuel)`);
      process.exit(1);
    }
    return { usuario: usuario.trim().toLowerCase(), nombre: nombre.trim(), esAdmin: false };
  });
}

/**
 * Inserta un usuario si no existe. Devuelve 'creado' o 'existe'. Idempotente por
 * el índice único `usuarios_usuario_uq`: el INSERT ... ON CONFLICT DO NOTHING no
 * toca la fila que ya está, así que la clave de quien ya la cambió queda intacta.
 *
 * El es_admin lo pone SÓLO en el INSERT: si el usuario ya existe, no se le cambia
 * (que alguien haya sido promovido o degradado desde la pantalla no lo revierte
 * un deploy).
 */
async function sembrar(u: Sembrable): Promise<'creado' | 'existe'> {
  const claveHash = await hashearClave(CLAVE_INICIAL);
  const rows = await q<{ id: number }>(
    `INSERT INTO usuarios (usuario, nombre, clave_hash, es_admin, debe_cambiar_clave)
     VALUES (lower(btrim($1)), btrim($2), $3, $4, true)
     ON CONFLICT (lower(btrim(usuario))) DO NOTHING
     RETURNING id`,
    [u.usuario, u.nombre, claveHash, u.esAdmin],
  );
  return rows.length > 0 ? 'creado' : 'existe';
}

async function main(): Promise<void> {
  const adminUsuario = (process.env.PANEL_ADMIN_USUARIO ?? 'lucho').trim().toLowerCase();
  const adminNombre = (process.env.PANEL_ADMIN_NOMBRE ?? 'Lucho').trim();

  const adicionales = parsearAdicionales(process.argv.slice(2));

  const aSembrar: Sembrable[] = [
    { usuario: adminUsuario, nombre: adminNombre, esAdmin: true },
    ...adicionales,
  ];

  let creados = 0;
  let existentes = 0;
  for (const u of aSembrar) {
    const estado = await sembrar(u);
    if (estado === 'creado') {
      creados += 1;
      console.log(`creado: ${u.usuario} (${u.nombre})${u.esAdmin ? ' — admin' : ''}`);
    } else {
      existentes += 1;
      console.log(`ya existe, no se toca: ${u.usuario}`);
    }
  }

  console.log('');
  console.log(`usuarios: ${creados} creados, ${existentes} ya existían`);
  if (creados > 0) {
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log(`  La clave inicial de los usuarios NUEVOS es:  ${CLAVE_INICIAL}`);
    console.log('  CAMBIALA EN EL PRIMER LOGIN. Mientras no lo hagas, el panel');
    console.log(`  está abierto con "${CLAVE_INICIAL}" para quien sepa el usuario.`);
    console.log('════════════════════════════════════════════════════════════════');
  }

  await getPool().end();
}

main().catch((err) => {
  console.error('seed-usuarios falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
