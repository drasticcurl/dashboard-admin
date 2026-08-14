import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from '@/lib/db';
import { listSteps } from '@/lib/funnels';
import { POST } from './route';
import { reemplazarCatalogo } from './_reemplazo';

// Mismo patrón que los tests de integración del repo: vitest no carga .env
// solo, y sin DATABASE_URL la suite se salta en vez de fallar.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

/**
 * El test que lockea el bug de producción (T07 §2): el POST de "Importar
 * pasos" hacía DELETE + INSERT sin incluir `counts_in_funnel`, y cada
 * importación la devolvía a `true` para todos los pasos del funnel, borrando
 * en silencio un ajuste que lib/funnels.ts:60 sí lee.
 *
 * Aislamiento total: se crea un funnel de prueba propio y se borra al final
 * (ON DELETE CASCADE se lleva sus pasos). Así la suite puede correr en
 * paralelo contra la misma base sin pisar los funnels del seed que leen
 * lib/queries/funnel.test.ts y compañía.
 */

const TEST_SLUG = `t07_counts_${process.pid}`;

describe.skipIf(!dbAvailable)('POST /api/config/steps — counts_in_funnel', () => {
  let funnelId: number;
  const catalogOriginal = [
    { stepIndex: 0, slug: 't07_landing', label: 'Landing', kind: 'landing' },
    { stepIndex: 1, slug: 't07_pregunta', label: 'Pregunta', kind: 'question' },
    { stepIndex: 2, slug: 't07_venta', label: 'Venta', kind: 'sales' },
  ] as const;

  beforeAll(async () => {
    const rows = await q<{ id: number }>(
      `INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash, active)
       VALUES ($1, 'T07 counts test', 'UTC', 'ARS', 'test-hash-' || md5(random()::text), true)
       RETURNING id`,
      [TEST_SLUG],
    );
    funnelId = rows[0]!.id;
    await q(
      `INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind)
       VALUES ($1, 0, 't07_landing', 'Landing', 'landing'),
              ($1, 1, 't07_pregunta', 'Pregunta', 'question'),
              ($1, 2, 't07_venta', 'Venta', 'sales')`,
      [funnelId],
    );
  });

  afterAll(async () => {
    if (funnelId) {
      await q('DELETE FROM funnels WHERE id = $1', [funnelId]);
    }
  });

  it('un paso marcado como "no cuenta en el embudo" SIGUE en false después de importar', async () => {
    await q(
      'UPDATE funnel_steps SET counts_in_funnel = false WHERE funnel_id = $1 AND slug = $2',
      [funnelId, 't07_pregunta'],
    );

    // La importación real: el mismo payload que arma la UI (sin counts).
    await reemplazarCatalogo(
      funnelId,
      catalogOriginal.map((s) => ({ stepIndex: s.stepIndex, slug: s.slug, label: s.label, kind: s.kind })),
    );

    const despues = await listSteps(funnelId);
    const fila = despues.find((s) => s.slug === 't07_pregunta');
    expect(fila).toBeDefined();
    // Si acá vuelve true, el bug está de vuelta: la importación resetó el
    // ajuste y el embudo cambió de números solo.
    expect(fila!.countsInFunnel).toBe(false);
    // Los demás pasos conservan su valor (los que estaban en true, en true).
    for (const s of despues) {
      if (s.slug === 't07_pregunta') continue;
      expect(s.countsInFunnel).toBe(true);
    }
  });

  it('un paso NUEVO del import nace con counts_in_funnel = true (el default)', async () => {
    const nuevo = {
      stepIndex: 3,
      slug: 't07_nuevo',
      label: 'Nuevo',
      kind: 'content' as const,
    };
    await reemplazarCatalogo(funnelId, [
      ...catalogOriginal.map((s) => ({ stepIndex: s.stepIndex, slug: s.slug, label: s.label, kind: s.kind })),
      nuevo,
    ]);
    const despues = await listSteps(funnelId);
    const fila = despues.find((s) => s.slug === nuevo.slug);
    expect(fila).toBeDefined();
    expect(fila!.countsInFunnel).toBe(true);
  });

  it('sin cookie: el POST devuelve 401 y no escribe nada', async () => {
    const before = await listSteps(funnelId);
    const req = new NextRequest('http://localhost/api/config/steps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        funnelId,
        steps: [{ stepIndex: 0, slug: 't07_x', label: 'X', kind: 'content' }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(await listSteps(funnelId)).toEqual(before);
  });
});
