import { createHash } from 'node:crypto';
import { getPool, q } from '../lib/db';

/**
 * Carga la ingest key de un funnel: hashea la key en claro (sha256 hex) y
 * guarda solo el hash en funnels.ingest_key_hash. El ingest compara contra
 * este hash, así la key nunca existe en la base ni en el dashboard (§3.1 del
 * plan).
 *
 * Uso: tsx scripts/set-ingest-key.ts <slug> <key>
 * La key la genera el deploy (openssl rand -hex 32) y vive en el .env del
 * funnel.
 */
async function main(): Promise<void> {
  const [slug, key] = process.argv.slice(2);
  if (!slug || !key) {
    console.error('uso: tsx scripts/set-ingest-key.ts <slug> <key>');
    process.exit(1);
  }

  const hash = createHash('sha256').update(key).digest('hex');
  const rows = await q<{ slug: string }>(
    'UPDATE funnels SET ingest_key_hash = $2 WHERE slug = $1 RETURNING slug',
    [slug, hash],
  );

  if (!rows.length) {
    console.error(`funnel '${slug}' no existe (mirá los slugs en la tabla funnels)`);
    process.exit(1);
  }

  // No se imprime la key: solo el prefijo del hash, para que no quede en el
  // historial de la shell ni en los logs.
  console.log(`ingest key de '${slug}' actualizada (hash ${hash.slice(0, 6)}…)`);
  await getPool().end();
}

main().catch((err) => {
  console.error('set-ingest-key falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
