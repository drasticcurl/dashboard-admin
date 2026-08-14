import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, tx } from '../lib/db';

/**
 * Aplica db/migrations/*.sql en orden alfabético, cada uno dentro de una
 * transacción con su registro en schema_migrations: si una migración falla,
 * ROLLBACK deja la base intacta y el proceso sale con código 1. Corrido dos
 * veces, la segunda no aplica nada y sale 0 (idempotente por tabla, no por
 * confianza en el IF NOT EXISTS).
 */
const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

async function main(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    const already = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (already.rowCount) {
      skipped += 1;
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      });
    } catch (err) {
      console.error(`migración fallida: ${file}`);
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    applied += 1;
    console.log(`aplicada: ${file}`);
  }

  console.log(`migraciones: ${applied} aplicadas, ${skipped} salteadas`);
  await pool.end();
}

main().catch((err) => {
  console.error('migración fallida:', err instanceof Error ? err.message : err);
  process.exit(1);
});
