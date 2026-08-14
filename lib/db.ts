import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';

// A diferencia de lib/supabase.ts de los funnels, acá NO hay modo degradado:
// si no hay base no hay nada que hacer, y el error tiene que salir fuerte y
// temprano en lugar de dejar al panel respondiendo con datos vacíos.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL no está configurada: sin base no hay panel');
    }
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Un Postgres que se reinicia (o un cron de Docker) no puede tumbar el
    // proceso: sin listener, el 'error' de un pool se propaga como excepción
    // no capturada y PM2 lo mata.
    pool.on('error', (err) => {
      console.error('[pg] error en el pool (la conexión se reintenta sola):', err.message);
    });
  }
  return pool;
}

/**
 * Query de una sola vez. Los parámetros SIEMPRE van como $1, $2 — nunca
 * interpolados: este proyecto recibe payloads de webhooks y de un ingest
 * público, y acá es la única defensa contra inyección SQL.
 */
export async function q<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
  const res = await getPool().query(sql, params);
  return res.rows as T[];
}

/** Una sola fila o null. */
export async function q1<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Transacción: BEGIN, callback, COMMIT; ROLLBACK y re-throw si el callback
 * tira. El cliente se libera siempre, también cuando el COMMIT falla.
 */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
