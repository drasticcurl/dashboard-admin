/**
 * Fabrica una cookie de sesión válida para un usuario, sin pasar por el login.
 *
 *   node tasks/usuarios-y-tareas/_cookie.mjs <usuarioId>
 *   node tasks/usuarios-y-tareas/_cookie.mjs 2 --curl
 *
 * POR QUÉ EXISTE. T03 y T05 corren en olas distintas de T04, que es la que
 * construye el login con usuario y clave. Sin esto, la verificación de T03 (los
 * 403 con la cookie de otro usuario) no se podría correr hasta que T04 mergee — y
 * es justo la verificación que más importa del módulo.
 *
 * Es el mismo truco que ya usa `middleware.test.ts:123-135`: replicar el formato
 * del token con la primitiva de crypto en vez de mockear.
 *
 * SÓLO PARA DESARROLLO. Lee `DASHBOARD_PASSWORD` del `.env` local, así que la
 * cookie que produce no vale en ninguna otra instalación.
 */

import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const raiz = path.resolve(import.meta.dirname, '..', '..');
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(raiz, '.env'))) {
  process.loadEnvFile(path.join(raiz, '.env'));
}

// El mismo default que lib/auth.ts (D1): sin PANEL_SESSION_SECRET, firma con
// DASHBOARD_PASSWORD.
const secreto = process.env.PANEL_SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
if (!secreto) {
  console.error('falta PANEL_SESSION_SECRET o DASHBOARD_PASSWORD en el .env');
  process.exit(1);
}

const id = process.argv[2];
if (!/^\d+$/.test(id ?? '')) {
  console.error('uso: node tasks/usuarios-y-tareas/_cookie.mjs <usuarioId> [--curl]');
  console.error('  el id sale de: psql "$DATABASE_URL" -tAc "SELECT id, usuario FROM usuarios ORDER BY id"');
  process.exit(1);
}

const payload = `${id}.${Date.now()}`;
const sig = crypto.createHmac('sha256', secreto).update(payload).digest('hex');
const token = `${payload}.${sig}`;

if (process.argv.includes('--curl')) {
  console.log(`-H "Cookie: panel_token=${token}"`);
} else {
  console.log(token);
}
