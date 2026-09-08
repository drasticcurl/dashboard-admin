/**
 * Tests de integración de `lib/queries/tareas.ts` — contra Postgres real.
 *
 * Patrón de `lib/queries/reconciliacion.integracion.test.ts` y de
 * `lib/queries/usuarios.test.ts`: `process.loadEnvFile`,
 * `describe.skipIf(!dbAvailable)`, prefijo `test-tarea-` en los TÍTULOS de las
 * tarjetas y `test-usr-` en los usuarios de prueba, y `cleanup()` en beforeEach Y
 * afterEach (una corrida interrumpida deja basura y la siguiente lee de más).
 *
 * El orden del cleanup importa: se borran las TAREAS antes que los USUARIOS,
 * porque `tareas.asignado_a` y `tarea_comentarios.usuario_id` son FK RESTRICT —
 * borrar primero al usuario fallaría. Los links y comentarios caen por CASCADE al
 * borrar la tarea.
 *
 * Implementa las 17 verificaciones de §6 de T02.
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
  listarTareas,
  crearTarea,
  editarTarea,
  moverTarea,
  reordenarColumna,
  borrarTarea,
  agregarLink,
  borrarLink,
  comentar,
  archivarHechasViejas,
  TareaInputError,
  type Columna,
} from './tareas';

const PREFIX_TAREA = 'test-tarea-';
const PREFIX_USR = 'test-usr-';
const tt = (s: string): string => `${PREFIX_TAREA}${s}`;
const uu = (s: string): string => `${PREFIX_USR}${s}`;

/**
 * Cleanup total del prefijo. Las tareas PRIMERO (por el FK RESTRICT hacia
 * usuarios), y se identifican por dos vías: título con prefijo, o asignadas/creadas
 * por un usuario de prueba. Así una tarjeta a la que un test le cambió el título
 * igual se limpia.
 */
async function cleanup(): Promise<void> {
  // Comentarios y links de cualquier tarea de prueba (CASCADE los borraría igual
  // al borrar la tarea, pero también hay comentarios de usuarios de prueba en
  // tarjetas que podrían no tener el prefijo — se limpian explícito).
  await q(
    `DELETE FROM tarea_comentarios WHERE usuario_id IN
       (SELECT id FROM usuarios WHERE usuario LIKE $1)`,
    [`${PREFIX_USR}%`],
  );
  // Tareas: por título de prueba o por usuario de prueba (asignado o creador).
  await q(
    `DELETE FROM tareas
      WHERE titulo LIKE $1
         OR asignado_a IN (SELECT id FROM usuarios WHERE usuario LIKE $2)
         OR creado_por IN (SELECT id FROM usuarios WHERE usuario LIKE $2)`,
    [`${PREFIX_TAREA}%`, `${PREFIX_USR}%`],
  );
  // Y recién ahora los usuarios.
  await q(`DELETE FROM usuarios WHERE usuario LIKE $1`, [`${PREFIX_USR}%`]);
}

let contador = 0;
/** Crea un usuario de prueba con `crearUsuario` de T01. El sufijo numérico evita
 *  chocar con el índice único cuando un test crea más de uno. */
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

/** Ids de las tarjetas de una columna, en el orden en que las devuelve el tablero. */
async function idsDe(columna: Columna, asignadoA?: number): Promise<number[]> {
  const tareas = await listarTareas(asignadoA != null ? { asignadoA } : {});
  return tareas.filter((t) => t.columna === columna).map((t) => t.id);
}

describe.skipIf(!dbAvailable)('lib/queries/tareas — contra Postgres', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('1. crear con lo mínimo → defaults por_hacer / media, resto null', async () => {
    const usr = await crearUsr('ana');
    const t = await crearTarea({ titulo: tt('mínima'), asignadoA: usr }, usr);

    expect(t.columna).toBe('por_hacer');
    expect(t.prioridad).toBe('media');
    expect(t.notas).toBeNull();
    expect(t.venceEl).toBeNull();
    expect(t.hechaAt).toBeNull();
    expect(t.asignadoA).toBe(usr);
    expect(t.creadoPor).toBe(usr);
    expect(t.links).toEqual([]);
    expect(t.comentarios).toEqual([]);
  });

  it('2. listarTareas({}) trae asignadoNombre resuelto y listas vacías', async () => {
    const usr = await crearUsr('beto');
    await crearTarea({ titulo: tt('con-nombre'), asignadoA: usr }, usr);

    const tareas = await listarTareas({});
    const t = tareas.find((x) => x.titulo === tt('con-nombre'));
    expect(t).toBeDefined();
    expect(t!.asignadoNombre).toBe('Test beto');
    expect(t!.links).toEqual([]);
    expect(t!.comentarios).toEqual([]);
  });

  it('3. una tarjeta con 3 links y 2 comentarios aparece UNA vez, listas completas', async () => {
    const usr = await crearUsr('caro');
    const t = await crearTarea({ titulo: tt('rica'), asignadoA: usr }, usr);
    await agregarLink(t.id, 'https://uno.example', 'Uno');
    await agregarLink(t.id, 'https://dos.example', null);
    await agregarLink(t.id, 'https://tres.example', 'Tres');
    await comentar(t.id, usr, 'primer comentario');
    await comentar(t.id, usr, 'segundo comentario');

    const tareas = await listarTareas({});
    const coincidencias = tareas.filter((x) => x.id === t.id);
    // NO hay join plano: una sola fila aunque tenga 3+2 hijos.
    expect(coincidencias).toHaveLength(1);
    const rica = coincidencias[0]!;
    expect(rica.links).toHaveLength(3);
    expect(rica.comentarios).toHaveLength(2);
    expect(rica.links.map((l) => l.url)).toEqual([
      'https://uno.example',
      'https://dos.example',
      'https://tres.example',
    ]);
    expect(rica.comentarios[0]!.usuarioNombre).toBe('Test caro');
  });

  it('4. listarTareas({ asignadoA }) filtra; null trae todas', async () => {
    const ana = await crearUsr('ana');
    const beto = await crearUsr('beto');
    await crearTarea({ titulo: tt('de-ana'), asignadoA: ana }, ana);
    await crearTarea({ titulo: tt('de-beto'), asignadoA: beto }, beto);

    const soloAna = await listarTareas({ asignadoA: ana });
    expect(soloAna.every((t) => t.asignadoA === ana)).toBe(true);
    expect(soloAna.some((t) => t.titulo === tt('de-ana'))).toBe(true);
    expect(soloAna.some((t) => t.titulo === tt('de-beto'))).toBe(false);

    const todas = await listarTareas({ asignadoA: null });
    expect(todas.some((t) => t.titulo === tt('de-ana'))).toBe(true);
    expect(todas.some((t) => t.titulo === tt('de-beto'))).toBe(true);
  });

  it('5. las archivadas no aparecen salvo archivadas: true', async () => {
    const usr = await crearUsr('dani');
    const t = await crearTarea({ titulo: tt('a-archivar'), asignadoA: usr, columna: 'hecho' }, usr);
    expect(t.hechaAt).not.toBeNull();
    // Archivarla: hecha_at bien viejo + archivar.
    await q(`UPDATE tareas SET hecha_at = now() - interval '10 days' WHERE id = $1`, [t.id]);
    await archivarHechasViejas(2);

    const sinArchivadas = await listarTareas({});
    expect(sinArchivadas.some((x) => x.id === t.id)).toBe(false);

    const conArchivadas = await listarTareas({ archivadas: true });
    expect(conArchivadas.some((x) => x.id === t.id)).toBe(true);
  });

  it('6. mover a hecho puebla hecha_at; sacarla lo limpia', async () => {
    const usr = await crearUsr('evi');
    const t = await crearTarea({ titulo: tt('viaja'), asignadoA: usr }, usr);
    expect(t.hechaAt).toBeNull();

    await moverTarea(t.id, 'hecho', [t.id]);
    let tras = (await listarTareas({})).find((x) => x.id === t.id)!;
    expect(tras.columna).toBe('hecho');
    expect(tras.hechaAt).not.toBeNull();

    await moverTarea(t.id, 'en_progreso', [t.id]);
    tras = (await listarTareas({})).find((x) => x.id === t.id)!;
    expect(tras.columna).toBe('en_progreso');
    expect(tras.hechaAt).toBeNull();
  });

  it('7. reordenar DENTRO de hecho NO cambia hecha_at', async () => {
    const usr = await crearUsr('facu');
    const a = await crearTarea({ titulo: tt('h-a'), asignadoA: usr, columna: 'hecho' }, usr);
    const b = await crearTarea({ titulo: tt('h-b'), asignadoA: usr, columna: 'hecho' }, usr);
    const antesA = (await listarTareas({})).find((x) => x.id === a.id)!.hechaAt;

    // Reordenar la columna hecho (dar vuelta el orden). moverTarea con la misma
    // columna destino: b antes que a.
    await moverTarea(a.id, 'hecho', [b.id, a.id]);
    const despuesA = (await listarTareas({})).find((x) => x.id === a.id)!.hechaAt;
    expect(despuesA).toBe(antesA); // el reloj NO se reinició

    // Y también vía reordenarColumna directo.
    const hechoIds = await idsDe('hecho', usr);
    await reordenarColumna('hecho', [...hechoIds].reverse());
    const finalA = (await listarTareas({})).find((x) => x.id === a.id)!.hechaAt;
    expect(finalA).toBe(antesA);
  });

  it('8. reordenarColumna deja posiciones 10,20,30 y listarTareas en ese orden', async () => {
    const usr = await crearUsr('gala');
    const a = await crearTarea({ titulo: tt('p-a'), asignadoA: usr }, usr);
    const b = await crearTarea({ titulo: tt('p-b'), asignadoA: usr }, usr);
    const c = await crearTarea({ titulo: tt('p-c'), asignadoA: usr }, usr);

    // Orden a mano: c, a, b.
    await reordenarColumna('por_hacer', [c.id, a.id, b.id]);

    const tareas = (await listarTareas({ asignadoA: usr })).filter(
      (t) => t.columna === 'por_hacer',
    );
    expect(tareas.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    expect(tareas.map((t) => t.posicion)).toEqual([10, 20, 30]);
  });

  it('9. reordenar con un id que no es de esa columna → TareaInputError', async () => {
    const usr = await crearUsr('hugo');
    const enPorHacer = await crearTarea({ titulo: tt('r-ph'), asignadoA: usr }, usr);
    const enHecho = await crearTarea({ titulo: tt('r-h'), asignadoA: usr, columna: 'hecho' }, usr);

    await expect(
      reordenarColumna('por_hacer', [enPorHacer.id, enHecho.id]),
    ).rejects.toBeInstanceOf(TareaInputError);
  });

  it('10. reordenar con lista incompleta → TareaInputError y ROLLBACK (posiciones intactas)', async () => {
    const usr = await crearUsr('ines');
    const a = await crearTarea({ titulo: tt('i-a'), asignadoA: usr }, usr);
    const b = await crearTarea({ titulo: tt('i-b'), asignadoA: usr }, usr);
    // Poner un orden conocido primero.
    await reordenarColumna('por_hacer', [a.id, b.id]);
    const posAntes = (await listarTareas({ asignadoA: usr })).map((t) => [t.id, t.posicion]);

    // Falta `b`: la columna tiene 2, llega 1.
    await expect(reordenarColumna('por_hacer', [a.id])).rejects.toBeInstanceOf(TareaInputError);

    const posDespues = (await listarTareas({ asignadoA: usr })).map((t) => [t.id, t.posicion]);
    expect(posDespues).toEqual(posAntes); // nada cambió: hubo ROLLBACK
  });

  it('11. asignar a un usuario inexistente → TareaInputError (FK 23503), no 500', async () => {
    await expect(
      crearTarea({ titulo: tt('sin-dueño'), asignadoA: 999999999 }, null),
    ).rejects.toBeInstanceOf(TareaInputError);
  });

  it('12. columna o prioridad inválidas → TareaInputError (CHECK 23514)', async () => {
    const usr = await crearUsr('juli');
    await expect(
      crearTarea(
        { titulo: tt('col-mala'), asignadoA: usr, columna: 'inexistente' as Columna },
        usr,
      ),
    ).rejects.toBeInstanceOf(TareaInputError);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      crearTarea({ titulo: tt('prio-mala'), asignadoA: usr, prioridad: 'urgentísima' as any }, usr),
    ).rejects.toBeInstanceOf(TareaInputError);
  });

  it('13. archivarHechasViejas(0) archiva las de hecho; correrlo de nuevo archiva 0', async () => {
    const usr = await crearUsr('kevin');
    await crearTarea({ titulo: tt('k-1'), asignadoA: usr, columna: 'hecho' }, usr);
    await crearTarea({ titulo: tt('k-2'), asignadoA: usr, columna: 'hecho' }, usr);

    const primera = await archivarHechasViejas(0);
    expect(primera).toBe(2);
    const segunda = await archivarHechasViejas(0);
    expect(segunda).toBe(0); // idempotente
  });

  it('14. archivarHechasViejas NO toca las que no están en hecho', async () => {
    const usr = await crearUsr('lola');
    const enCurso = await crearTarea({ titulo: tt('l-curso'), asignadoA: usr }, usr);
    const hecha = await crearTarea({ titulo: tt('l-hecha'), asignadoA: usr, columna: 'hecho' }, usr);

    const archivadas = await archivarHechasViejas(0);
    expect(archivadas).toBe(1);

    const activas = await listarTareas({});
    expect(activas.some((t) => t.id === enCurso.id)).toBe(true); // sigue viva
    expect(activas.some((t) => t.id === hecha.id)).toBe(false); // archivada
  });

  it('15. borrar una tarjeta se lleva links y comentarios (CASCADE) y NO al usuario', async () => {
    const usr = await crearUsr('mora');
    const t = await crearTarea({ titulo: tt('borrable'), asignadoA: usr }, usr);
    const link = await agregarLink(t.id, 'https://borrar.example');
    const com = await comentar(t.id, usr, 'un comentario');

    await borrarTarea(t.id);

    const linksRestantes = await q(`SELECT 1 FROM tarea_links WHERE id = $1`, [link.id]);
    const comsRestantes = await q(`SELECT 1 FROM tarea_comentarios WHERE id = $1`, [com.id]);
    const usuarioSigue = await q(`SELECT 1 FROM usuarios WHERE id = $1`, [usr]);
    expect(linksRestantes).toHaveLength(0); // CASCADE
    expect(comsRestantes).toHaveLength(0); // CASCADE
    expect(usuarioSigue).toHaveLength(1); // RESTRICT no lo tocó
  });

  it('16. un link con javascript: → TareaInputError (mensaje legible, no 500)', async () => {
    const usr = await crearUsr('nico');
    const t = await crearTarea({ titulo: tt('con-link-malo'), asignadoA: usr }, usr);
    await expect(agregarLink(t.id, 'javascript:alert(1)')).rejects.toBeInstanceOf(TareaInputError);
    // Y no quedó ningún link guardado.
    const tras = (await listarTareas({})).find((x) => x.id === t.id)!;
    expect(tras.links).toEqual([]);
  });

  it('17. dos tarjetas creadas en la MISMA transacción comparten updated_at (D13)', async () => {
    const usr = await crearUsr('oli');
    // Se crean en una sola transacción a mano: now() es la hora de INICIO de la
    // transacción, constante hasta el COMMIT, así que las dos comparten updated_at
    // al milisegundo. Es el recordatorio de que updated_at NO ordena nada.
    const { getPool } = await import('../db');
    const client = await getPool().connect();
    let idA = 0;
    let idB = 0;
    try {
      await client.query('BEGIN');
      const a = await client.query<{ id: string }>(
        `INSERT INTO tareas (titulo, asignado_a) VALUES ($1, $2) RETURNING id`,
        [tt('tx-a'), usr],
      );
      const b = await client.query<{ id: string }>(
        `INSERT INTO tareas (titulo, asignado_a) VALUES ($1, $2) RETURNING id`,
        [tt('tx-b'), usr],
      );
      await client.query('COMMIT');
      idA = Number(a.rows[0]!.id);
      idB = Number(b.rows[0]!.id);
    } finally {
      client.release();
    }

    const tareas = await listarTareas({ asignadoA: usr });
    const ta = tareas.find((x) => x.id === idA)!;
    const tb = tareas.find((x) => x.id === idB)!;
    expect(ta.updatedAt).toBe(tb.updatedAt);
  });

  // Una verificación extra que no está numerada pero cierra el ciclo de editarTarea:
  // editar cambia el contenido sin tocar columna/hecha_at.
  it('editarTarea cambia contenido sin tocar columna ni hecha_at', async () => {
    const usr = await crearUsr('pati');
    const t = await crearTarea({ titulo: tt('editable'), asignadoA: usr, columna: 'hecho' }, usr);
    const hechaAntes = t.hechaAt;

    const editada = await editarTarea(t.id, {
      titulo: tt('editada'),
      notas: 'nuevas notas',
      prioridad: 'alta',
      venceEl: '2030-01-15',
    });
    expect(editada.titulo).toBe(tt('editada'));
    expect(editada.notas).toBe('nuevas notas');
    expect(editada.prioridad).toBe('alta');
    expect(editada.venceEl).toBe('2030-01-15');
    expect(editada.columna).toBe('hecho'); // intacta
    expect(editada.hechaAt).toBe(hechaAntes); // el reloj no se movió

    // borrarLink: agregar y borrar uno deja la lista vacía.
    const link = await agregarLink(t.id, 'https://x.example');
    await borrarLink(link.id);
    const tras = (await listarTareas({})).find((x) => x.id === t.id)!;
    expect(tras.links).toEqual([]);
  });
});
