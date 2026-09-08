#!/usr/bin/env node
/**
 * Cron de archivado del tablero de tareas (módulo usuarios-y-tareas, §7 del plan).
 * Archiva lo que lleva más de N días en la columna "hecho" llamando a
 * `archivarHechasViejas(N)` de lib/queries/tareas.ts (T02).
 *
 * Uso:
 *   npm run tareas:archivar        # días de gracia = 2 (el default del plan)
 *   npm run tareas:archivar -- 7   # días de gracia = 7 (para probar sin esperar)
 *
 * El día de gracia va POR ARGUMENTO y no hardcodeado: es lo que permite probarlo
 * sin esperar dos días reales, y lo que evita que alguien edite el script cuando
 * quiera correrlo con otro umbral.
 *
 * Exit 0 SIEMPRE que archive bien, incluso si archivó 0: la mayoría de los días
 * no hay nada que archivar y eso no es un error (a diferencia de fetch-fx, que
 * sale 1 cuando no consigue la cotización). Loguea cuántas tocó con la fecha,
 * porque un cron que no dice qué hizo no se puede auditar cuando alguien pregunta
 * por qué desapareció una tarjeta.
 *
 * Línea de cron: ver deploy/cron.panel (una vez al día; la granularidad es de N
 * días, así que correrlo más seguido son corridas que archivan 0).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool } from '../lib/db';
import { archivarHechasViejas } from '../lib/queries/tareas';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción viene
// de PM2 (via --env-file) y no existe. `process.loadEnvFile` es de Node >= 20.12.
// Mismo patrón que lib/queries/reconciliacion.integracion.test.ts:46-48.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  // Un único argumento posicional opcional: los días de gracia. Se valida que
  // sea un entero >= 0 para que un typo ('dos', '-1') falle claro y no se
  // traduzca a un intervalo raro en Postgres.
  let dias = 2;
  if (args.length > 0) {
    const parsed = Number(args[0]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`días de gracia inválido: '${args[0]}' (espera un entero >= 0)`);
    }
    dias = parsed;
  }

  const n = await archivarHechasViejas(dias);
  const hoy = new Date().toISOString().slice(0, 10);
  const plural = n === 1 ? 'tarea archivada' : 'tareas archivadas';
  console.log(`${hoy}: ${n} ${plural} (más de ${dias} días en "hecho")`);
  return n;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('archivar-tareas falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    // await pool.end() como scripts/migrate.ts:50: sin esto el proceso queda
    // colgado esperando la conexión y el cron acumula procesos zombis.
    .finally(() => getPool().end().catch(() => {}));
}
