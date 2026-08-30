/**
 * `npm run ads:token` — verifica que el META_ADS_TOKEN pueda ESCRIBIR en las
 * cuentas publicitarias (P-A01). Se corre en cada deploy para que un token sin
 * `ads_management` no pase desapercibido hasta que el worker falle en runtime.
 *
 * QUÉ HACE Y EN QUÉ ORDEN
 * 1. `debug_token` → lista los scopes y avisa cuál falta. Imprime la versión de
 *    la Graph API en uso (D-A16b): un deploy no puede quedar apuntando a una
 *    versión retirada sin que nadie lo vea.
 * 2. Lista las cuentas activas de `ad_accounts` y su moneda/zona: avisa si una
 *    no factura en EUR (D-A10, esa cuenta no se va a procesar) o si tiene la
 *    zona en NULL (P-A03, las métricas agrupan mal el día).
 * 3. Hace la escritura no-op (status=PAUSED) SOLO sobre el objeto de la
 *    allowlist (`ADS_TEST_OBJECT_ID`), releído y verificado antes de escribir.
 * 4. Sale con 1 si el token no puede escribir sobre el objeto autorizado.
 *
 * LA ALLOWLIST NO ES UNA BÚSQUEDA
 * El script NO busca "la primera campaña pausada": escribir sobre un objeto real
 * elegido por orden de listado es una prueba de instalación que puede caer sobre
 * cualquier cosa el día que cambie el orden o el filtro. Sin ADS_TEST_OBJECT_ID
 * no prueba la escritura, lo dice en voz alta, y sale con 0 (no es un fallo del
 * token, es configuración que falta).
 */

import { q } from '../lib/db';
import { MetaAdsError, setStatus, verificarPermisos } from '../lib/ads/meta';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '../lib/moneda-reporte';

function token(): string {
  const t = process.env.META_ADS_TOKEN;
  if (!t) {
    console.error('FALTA META_ADS_TOKEN en el entorno');
    process.exit(1);
  }
  return t;
}

async function main(): Promise<void> {
  // ─── 1. Permisos declarados y versión de la API ────────────────────────────
  let permisos;
  try {
    permisos = await verificarPermisos();
  } catch (e) {
    console.error('debug_token falló (pasa con algunos tokens de usuario del sistema; la escritura decide):');
    console.error(e instanceof Error ? e.message : String(e));
    permisos = null;
  }

  if (permisos) {
    console.log(`Graph API: ${permisos.apiVersion}`);
    console.log(`scopes: ${permisos.scopes.join(', ') || '(ninguno)'}`);
    if (permisos.ok) {
      console.log('permisos: OK (ads_read y ads_management)');
    } else {
      console.log(`permisos: FALTA ${permisos.falta.join(', ')}`);
    }
  }

  // ─── 2. Cuentas activas: moneda y zona ─────────────────────────────────────
  const cuentas = await q<{
    account_id: string;
    currency: string | null;
    timezone: string | null;
  }>(
    `SELECT account_id, currency, timezone
       FROM ad_accounts WHERE active AND platform = 'meta' ORDER BY account_id`,
  );
  for (const c of cuentas) {
    const avisos: string[] = [];
    if (c.currency !== MONEDA_REPORTE)
      avisos.push(`moneda ${c.currency ?? 'NULL'} ≠ ${MONEDA_REPORTE} (no se procesa)`);
    if (c.timezone === null) avisos.push('timezone NULL (las métricas agrupan mal el día)');
    console.log(
      `cuenta ${c.account_id}: ${c.currency ?? '?'} / ${c.timezone ?? 'sin zona'}${avisos.length ? `  ⚠ ${avisos.join(' · ')}` : ''}`,
    );
  }

  // ─── 3. Escritura no-op sobre el objeto de la allowlist ────────────────────
  const objectId = process.env.ADS_TEST_OBJECT_ID;
  if (!objectId) {
    console.log('escritura no verificada: falta ADS_TEST_OBJECT_ID (allowlist)');
    console.log('  El permiso de escritura NO quedó demostrado. Agregá un objeto PAUSADO y descartable a .env y volvé a correr.');
    process.exit(0);
  }

  const t = token();
  const apiVersion = permisos?.apiVersion ?? process.env.META_API_VERSION ?? 'v21.0';

  // Releer ANTES de escribir: que exista y que esté PAUSADO. Un no-op sobre algo
  // activo no es un no-op.
  let objeto: {
    id?: string;
    name?: string;
    status?: string;
    account_id?: string;
  } | null = null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${objectId}?fields=id,name,status,account_id`,
      { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(30_000) },
    );
    const body = (await res.json().catch(() => null)) as {
      id?: string;
      name?: string;
      status?: string;
      account_id?: string;
      error?: { message?: string };
    } | null;
    if (body && body.error) throw new MetaAdsError(body.error.message ?? 'error al releer el objeto');
    objeto = body;
  } catch (e) {
    console.error(`no se pudo releer el objeto ${objectId}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!objeto || !objeto.id) {
    console.error(`el objeto de la allowlist ${objectId} no existe en Meta`);
    process.exit(1);
  }
  if (objeto.status !== 'PAUSED') {
    console.error(
      `el objeto ${objectId} («${objeto.name ?? '?'}») no está PAUSED (status=${objeto.status ?? '?'}): no es un no-op, no se escribe`,
    );
    process.exit(1);
  }

  try {
    await setStatus(objectId, 'PAUSED');
    console.log(
      `escritura OK: ${objectId} («${objeto.name ?? '?'}», cuenta ${objeto.account_id ?? '?'}) aceptó status=PAUSED (no-op)`,
    );
    process.exit(0);
  } catch (e) {
    const m = e instanceof MetaAdsError ? `${e.message} (code ${e.code ?? '-'})` : String(e);
    console.error(`escritura FALLÓ sobre ${objectId}: ${m}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('verificar-token-ads falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
