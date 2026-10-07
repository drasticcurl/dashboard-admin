import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  countLeads,
  fetchAllLeads,
  fetchLastLeadAt,
  fetchLeadEmailsInRange,
  fetchRecentLeads,
  getLeadsEnv,
  type LeadsEnv,
} from './supabase-leads';

/**
 * Camino Postgres de los leads (LEADS_DATABASE_URL_<SLUG>), contra un SCHEMA
 * descartable dentro de DATABASE_URL (el rol de panel_test en la VPS no puede
 * crear bases). Sin DATABASE_URL se salta, como el resto de los tests con base.
 */
const ADMIN_URL = process.env.DATABASE_URL;

describe.skipIf(!ADMIN_URL)('supabase-leads: camino Postgres', () => {
  const schema = `leads_pg_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  let url = '';

  beforeAll(async () => {
    const u = new URL(ADMIN_URL!);
    // El pool de los leads hace `FROM clientes` sin schema: el search_path lo
    // apunta al schema descartable.
    u.searchParams.set('options', `-c search_path=${schema}`);
    url = u.toString();

    const c = new Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`CREATE TABLE "${schema}".clientes (
      email text NOT NULL, nombre text, created_at timestamptz, compro boolean,
      utm_source text, utm_medium text, utm_campaign text, utm_content text,
      tipo_hinchazon smallint, severidad smallint)`);
    await c.query(`INSERT INTO "${schema}".clientes (email, nombre, created_at, utm_source, tipo_hinchazon) VALUES
      ('Ana@X.com ', 'Ana', '2026-06-01T10:00:00Z', 'facebook', 2),
      ('bea@x.com', 'Bea', '2026-06-15T10:00:00Z', null, null),
      ('caro@x.com', null, '2026-06-30T19:46:08.707086Z', 'tiktok', 4)`);
    await c.end();
  });

  afterAll(async () => {
    const c = new Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await c.end();
  });

  const env = (): LeadsEnv => ({ kind: 'pg', url });

  it('LEADS_DATABASE_URL_<SLUG> gana sobre las vars de Supabase', () => {
    process.env.LEADS_DATABASE_URL_PRUEBA = 'postgres://ro@127.0.0.1/x';
    process.env.SUPABASE_URL_PRUEBA = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY_PRUEBA = 'k';
    try {
      expect(getLeadsEnv('prueba')).toEqual({ kind: 'pg', url: 'postgres://ro@127.0.0.1/x' });
      delete process.env.LEADS_DATABASE_URL_PRUEBA;
      expect(getLeadsEnv('prueba')).toEqual({ kind: 'rest', url: 'https://x.supabase.co', key: 'k' });
    } finally {
      delete process.env.LEADS_DATABASE_URL_PRUEBA;
      delete process.env.SUPABASE_URL_PRUEBA;
      delete process.env.SUPABASE_SERVICE_KEY_PRUEBA;
    }
  });

  it('cuenta total y por ventana [gte, lt)', async () => {
    expect(await countLeads(env())).toBe(3);
    expect(await countLeads(env(), { gte: '2026-06-15T10:00:00Z' })).toBe(2);
    expect(await countLeads(env(), { gte: '2026-06-01T00:00:00Z', lt: '2026-06-15T10:00:00Z' })).toBe(1);
  });

  it('recientes: orden desc, limit, created_at como string ISO (igual que PostgREST)', async () => {
    const rows = await fetchRecentLeads(env(), 2);
    expect(rows.map((r) => r.email)).toEqual(['caro@x.com', 'bea@x.com']);
    expect(rows[0].created_at).toBe('2026-06-30T19:46:08.707086+00:00');
    expect(Number.isNaN(Date.parse(rows[0].created_at))).toBe(false);
    expect(rows[0].tipo_hinchazon).toBe(4);
  });

  it('todos (con y sin since), emails de una ventana normalizados, último lead', async () => {
    expect(await fetchAllLeads(env())).toHaveLength(3);
    expect(await fetchAllLeads(env(), { since: '2026-06-10T00:00:00Z' })).toHaveLength(2);
    expect(
      await fetchLeadEmailsInRange(env(), { gte: '2026-06-01T00:00:00Z', lt: '2026-06-02T00:00:00Z' }),
    ).toEqual(['ana@x.com']);
    expect(await fetchLastLeadAt(env())).toBe('2026-06-30T19:46:08.707086+00:00');
  });
});
