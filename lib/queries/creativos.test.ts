/**
 * Tests de integración de `lib/queries/creativos.ts` — contra Postgres real.
 *
 * Patrón de `lib/queries/tareas.test.ts`: `process.loadEnvFile`,
 * `describe.skipIf(!dbAvailable)`, prefijo `test-creativo-` en los NOMBRES y
 * `test-usr-creativo-` en los usuarios de prueba, `cleanup()` en beforeEach Y
 * afterEach.
 *
 * A diferencia de tareas, acá `creado_por` es `ON DELETE SET NULL` (no
 * RESTRICT): el orden de cleanup no importa por FK, pero se borran los
 * creativos antes igual, por prolijidad y para no dejar filas con
 * `creado_por = NULL` de una corrida anterior confundiendo la siguiente.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);

import { q } from '../db';
import { hashearClave } from '../auth';
import { crearUsuario } from './usuarios';
import {
  listarCreativos,
  crearCreativo,
  editarCreativo,
  borrarCreativo,
  CreativoInputError,
} from './creativos';

const PREFIX_CREATIVO = 'test-creativo-';
const PREFIX_USR = 'test-usr-creativo-';
const cc = (s: string): string => `${PREFIX_CREATIVO}${s}`;
const uu = (s: string): string => `${PREFIX_USR}${s}`;

async function cleanup(): Promise<void> {
  await q(
    `DELETE FROM creativos
      WHERE nombre LIKE $1
         OR creado_por IN (SELECT id FROM usuarios WHERE usuario LIKE $2)`,
    [`${PREFIX_CREATIVO}%`, `${PREFIX_USR}%`],
  );
  await q(`DELETE FROM usuarios WHERE usuario LIKE $1`, [`${PREFIX_USR}%`]);
}

let contador = 0;
async function crearUsr(nombre: string): Promise<number> {
  contador += 1;
  const claveHash = await hashearClave('una-clave-de-quince-o-mas');
  const creado = await crearUsuario({
    usuario: uu(`${nombre}${contador}`),
    nombre: `Test ${nombre}`,
    claveHash,
  });
  return creado.id;
}

describe.skipIf(!dbAvailable)('lib/queries/creativos — contra Postgres', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('1. crear con los tres campos → los devuelve tal cual, creadoPor resuelto', async () => {
    const usr = await crearUsr('ana');
    const c = await crearCreativo(
      { nombre: cc('video-uno'), link: 'https://ejemplo.test/v1', rendimiento: 'alto' },
      usr,
    );
    expect(c.nombre).toBe(cc('video-uno'));
    expect(c.link).toBe('https://ejemplo.test/v1');
    expect(c.rendimiento).toBe('alto');
    expect(c.creadoPor).toBe(usr);
    expect(c.creadoPorNombre).toBe('Test ana');
  });

  it('2. crear con creadoPor null (fallback D10) → creadoPorNombre null', async () => {
    const c = await crearCreativo(
      { nombre: cc('sin-dueño'), link: 'https://ejemplo.test/v2', rendimiento: 'medio' },
      null,
    );
    expect(c.creadoPor).toBeNull();
    expect(c.creadoPorNombre).toBeNull();
  });

  it('3. listarCreativos() trae lo más nuevo primero', async () => {
    const usr = await crearUsr('beto');
    const a = await crearCreativo(
      { nombre: cc('primero'), link: 'https://ejemplo.test/a', rendimiento: 'bajo' },
      usr,
    );
    const b = await crearCreativo(
      { nombre: cc('segundo'), link: 'https://ejemplo.test/b', rendimiento: 'bajo' },
      usr,
    );
    const lista = await listarCreativos();
    const idxA = lista.findIndex((x) => x.id === a.id);
    const idxB = lista.findIndex((x) => x.id === b.id);
    expect(idxB).toBeLessThan(idxA); // b es más nuevo, aparece antes
  });

  it('4. nombre vacío → CreativoInputError', async () => {
    const usr = await crearUsr('caro');
    await expect(
      crearCreativo({ nombre: '   ', link: 'https://ejemplo.test/x', rendimiento: 'alto' }, usr),
    ).rejects.toBeInstanceOf(CreativoInputError);
  });

  it('5. link sin http(s):// (incluye javascript:) → CreativoInputError, no 500', async () => {
    const usr = await crearUsr('dani');
    await expect(
      crearCreativo({ nombre: cc('sin-link'), link: 'no-es-una-url', rendimiento: 'alto' }, usr),
    ).rejects.toBeInstanceOf(CreativoInputError);
    await expect(
      crearCreativo(
        { nombre: cc('link-malo'), link: 'javascript:alert(1)', rendimiento: 'alto' },
        usr,
      ),
    ).rejects.toBeInstanceOf(CreativoInputError);
  });

  it('6. rendimiento fuera del vocabulario → CreativoInputError (CHECK 23514)', async () => {
    const usr = await crearUsr('evi');
    await expect(
      crearCreativo(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { nombre: cc('rend-malo'), link: 'https://ejemplo.test/y', rendimiento: 'excelente' as any },
        usr,
      ),
    ).rejects.toBeInstanceOf(CreativoInputError);
  });

  it('7. usuario inexistente en creadoPor → CreativoInputError (FK 23503)', async () => {
    await expect(
      crearCreativo(
        { nombre: cc('dueño-falso'), link: 'https://ejemplo.test/z', rendimiento: 'alto' },
        999999999,
      ),
    ).rejects.toBeInstanceOf(CreativoInputError);
  });

  it('8. editarCreativo cambia campos sueltos sin tocar los demás', async () => {
    const usr = await crearUsr('facu');
    const c = await crearCreativo(
      { nombre: cc('editable'), link: 'https://ejemplo.test/e', rendimiento: 'medio' },
      usr,
    );
    const editado = await editarCreativo(c.id, { rendimiento: 'alto' });
    expect(editado.rendimiento).toBe('alto');
    expect(editado.nombre).toBe(cc('editable')); // intacto
    expect(editado.link).toBe('https://ejemplo.test/e'); // intacto
  });

  it('9. editar cualquiera puede tocar la fila de otro usuario (sin dueño por fila)', async () => {
    const autor = await crearUsr('gala');
    const otro = await crearUsr('hugo');
    const c = await crearCreativo(
      { nombre: cc('compartido'), link: 'https://ejemplo.test/comp', rendimiento: 'bajo' },
      autor,
    );
    // No hay noción de "es de otro" en esta capa: editarCreativo no recibe ni
    // valida quién edita (esa decisión la toma explícitamente el route, que
    // NO comprueba dueño — ver docblock de la 034).
    const editado = await editarCreativo(c.id, { nombre: cc('compartido-editado') });
    expect(editado.nombre).toBe(cc('compartido-editado'));
    expect(editado.creadoPor).toBe(autor); // el autor original no cambia
    void otro;
  });

  it('10. editar un id inexistente → CreativoInputError', async () => {
    await expect(editarCreativo(999999999, { nombre: 'x' })).rejects.toBeInstanceOf(
      CreativoInputError,
    );
  });

  it('11. borrarCreativo borra la fila y NO al usuario', async () => {
    const usr = await crearUsr('ines');
    const c = await crearCreativo(
      { nombre: cc('borrable'), link: 'https://ejemplo.test/borrar', rendimiento: 'alto' },
      usr,
    );
    await borrarCreativo(c.id);

    const restante = await q(`SELECT 1 FROM creativos WHERE id = $1`, [c.id]);
    const usuarioSigue = await q(`SELECT 1 FROM usuarios WHERE id = $1`, [usr]);
    expect(restante).toHaveLength(0);
    expect(usuarioSigue).toHaveLength(1);
  });

  it('12. borrar el usuario que creó un creativo → creadoPor pasa a NULL (SET NULL, no RESTRICT)', async () => {
    const usr = await crearUsr('juli');
    const c = await crearCreativo(
      { nombre: cc('huerfano'), link: 'https://ejemplo.test/huerfano', rendimiento: 'medio' },
      usr,
    );
    await q(`DELETE FROM usuarios WHERE id = $1`, [usr]);

    const lista = await listarCreativos();
    const tras = lista.find((x) => x.id === c.id)!;
    expect(tras.creadoPor).toBeNull();
    expect(tras.creadoPorNombre).toBeNull();
  });
});
