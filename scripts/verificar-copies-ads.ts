/**
 * `npm run ads:copies` — verifica contra la Marketing API en uso la forma real
 * de `/copies` (D-01 y D-02 del anexo del design). Su salida alimenta la task
 * 22.1 (`leerResultadoBatch` del Escritor_Copias) y confirma las filas
 * `verificado: false` del catálogo de errores (190, 17, 100-cupo).
 *
 * QUÉ HACE Y EN QUÉ ORDEN
 * 1. Imprime token/versión y relee la campaña de la allowlist: tiene que existir
 *    y estar PAUSED (una campaña de prueba descartable, igual que el criterio de
 *    `verificar-token-ads.ts`).
 * 2. PRUEBA SINCRÓNICA: POST /{campaña}/copies con status_option=PAUSED, primero
 *    sin deep_copy y después con deep_copy=true. Reporta la respuesta cruda de
 *    cada una: qué ids devuelve y con qué forma.
 * 3. PRUEBA DE BATCH: POST /{cuenta}/async_batch_requests con UNA sub-petición
 *    de copia profunda. Reporta: la forma del sobre (¿`async_batch_id`?), cómo
 *    avanza el estado, si el resultado viene en el sobre o en una edge aparte, y
 *    la forma del cuerpo de cada sub-petición terminada. Sondea hasta 300 s.
 * 4. ERRORES DSA/CUPO: reporta el código y subcódigo SOLO si Meta los devuelve
 *    en las pruebas anteriores. Si las copias pasan sin error, lo dice: los
 *    datos de DSA están cargados o la campaña no segmenta la UE, y las filas
 *    del catálogo siguen pendientes de confirmar por otra vía.
 *
 * OJO: ESTE SCRIPT CREA COPIAS REALES en la campaña de la allowlist (nacen
 * PAUSED, pero son objetos reales). NO corre en CI. La allowlist NO es una
 * búsqueda: sin ADS_TEST_CAMPAIGN_ID no crea nada, lo dice en voz alta y sale
 * con 0.
 */

import { MetaAdsError } from '../lib/ads/meta';

function token(): string {
  const t = process.env.META_ADS_TOKEN;
  if (!t) {
    console.error('FALTA META_ADS_TOKEN en el entorno');
    process.exit(1);
  }
  return t;
}

type Cuerpo = Record<string, unknown> & { error?: { message?: string; code?: number; error_subcode?: number } };

async function pedir(
  t: string,
  apiVersion: string,
  url: string,
  init?: { method?: string; body?: string },
): Promise<{ ok: boolean; status: number; texto: string; cuerpo: Cuerpo | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body
        ? {
            Authorization: `Bearer ${t}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          }
        : { Authorization: `Bearer ${t}` },
      body: init?.body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    return { ok: false, status: 0, texto: e instanceof Error ? e.message : String(e), cuerpo: null };
  }
  const texto = await res.text();
  let cuerpo: Cuerpo | null = null;
  try {
    cuerpo = JSON.parse(texto) as Cuerpo;
  } catch {
    cuerpo = null;
  }
  return { ok: res.ok, status: res.status, texto, cuerpo };
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const t = token();
  const apiVersion = process.env.META_API_VERSION ?? 'v21.0';
  console.log(`Graph API: ${apiVersion}\n`);

  const campaignId = process.env.ADS_TEST_CAMPAIGN_ID;
  if (!campaignId) {
    console.log('verificación no ejecutada: falta ADS_TEST_CAMPAIGN_ID (allowlist)');
    console.log('  Agregá a .env el id de una CAMPAÑA de prueba, PAUSED y descartable, y volvé a correr.');
    console.log('  El script NO busca «la primera campaña» ni elige objetos por orden de listado.');
    process.exit(0);
  }

  // ─── 1. Releer ANTES de escribir (criterio de verificar-token-ads.ts) ──────
  const antes = await pedir(
    t,
    apiVersion,
    `https://graph.facebook.com/${apiVersion}/${campaignId}?fields=id,name,status,account_id`,
  );
  if (!antes.ok || !antes.cuerpo || antes.cuerpo.error) {
    console.error(
      `no se pudo releer la campaña ${campaignId}: ${antes.cuerpo?.error?.message ?? `HTTP ${antes.status}`}`,
    );
    process.exit(1);
  }
  const nombre = String(antes.cuerpo.name ?? '?');
  const status = String(antes.cuerpo.status ?? '?');
  const accountId = String(antes.cuerpo.account_id ?? '');
  console.log(`campaña de prueba: ${campaignId} («${nombre}», status=${status}, cuenta ${accountId})`);
  if (status !== 'PAUSED') {
    console.error(`la campaña de la allowlist no está PAUSED (status=${status}): no es descartable, no se escribe`);
    process.exit(1);
  }

  // ─── 2. Prueba sincrónica: /copies sin deep_copy ───────────────────────────
  console.log('\n── /copies sincrónico, status_option=PAUSED, sin deep_copy ──');
  const r1 = await pedir(
    t,
    apiVersion,
    `https://graph.facebook.com/${apiVersion}/${campaignId}/copies`,
    { method: 'POST', body: 'status_option=PAUSED' },
  );
  console.log(`HTTP ${r1.status}`);
  console.log(r1.cuerpo ? JSON.stringify(r1.cuerpo, null, 2) : r1.texto);
  if (r1.cuerpo?.error) {
    console.log(`  → código ${r1.cuerpo.error.code ?? '-'}, subcódigo ${r1.cuerpo.error.error_subcode ?? '-'}`);
  }

  // ─── 3. Prueba sincrónica: /copies con deep_copy=true ──────────────────────
  console.log('\n── /copies sincrónico, status_option=PAUSED, deep_copy=true ──');
  const r2 = await pedir(
    t,
    apiVersion,
    `https://graph.facebook.com/${apiVersion}/${campaignId}/copies`,
    { method: 'POST', body: 'status_option=PAUSED&deep_copy=true' },
  );
  console.log(`HTTP ${r2.status}`);
  console.log(r2.cuerpo ? JSON.stringify(r2.cuerpo, null, 2) : r2.texto);
  if (r2.cuerpo?.error) {
    console.log(`  → código ${r2.cuerpo.error.code ?? '-'}, subcódigo ${r2.cuerpo.error.error_subcode ?? '-'}`);
  }

  // ─── 4. Prueba del batch asíncrono (una sola sub-petición) ─────────────────
  console.log('\n── batch asíncrono: /async_batch_requests con una sub-petición de copia profunda ──');
  if (!accountId) {
    console.log('  salteado: la campaña no devolvió account_id');
  } else {
    const sub = {
      method: 'POST',
      relative_url: `${campaignId}/copies`,
      body: 'status_option=PAUSED&deep_copy=true',
      name: 'probe-copia-batch',
    };
    const batch = await pedir(
      t,
      apiVersion,
      `https://graph.facebook.com/${apiVersion}/${accountId}/async_batch_requests`,
      {
        method: 'POST',
        body: `batch=${encodeURIComponent(JSON.stringify([sub]))}&include_headers=false`,
      },
    );
    console.log(`HTTP ${batch.status}`);
    console.log(batch.cuerpo ? JSON.stringify(batch.cuerpo, null, 2) : batch.texto);

    const batchId = batch.cuerpo?.async_batch_id ?? batch.cuerpo?.id ?? null;
    if (!batchId) {
      console.log('  → el sobre NO trae async_batch_id: reportar qué trae, que es lo que leerResultadoBatch tiene que soportar');
    } else {
      console.log(`\n  sondeo del lote ${batchId} (hasta 300 s):`);
      let finalizado = false;
      for (let i = 0; i < 60 && !finalizado; i++) {
        await esperar(5_000);
        const estado = await pedir(
          t,
          apiVersion,
          `https://graph.facebook.com/${apiVersion}/${batchId}?fields=status,result`,
        );
        const st = String(estado.cuerpo?.status ?? estado.cuerpo?.error?.message ?? '?');
        console.log(`  t+${(i + 1) * 5}s: status=${st}`);
        if (st === 'COMPLETE' || st === 'FAILED' || estado.cuerpo?.error) {
          console.log('  sobre final:');
          console.log(JSON.stringify(estado.cuerpo, null, 2));
          finalizado = true;
        }
      }
      console.log('\n  cuerpos de las sub-peticiones (edge /requests):');
      const peticiones = await pedir(
        t,
        apiVersion,
        `https://graph.facebook.com/${apiVersion}/${batchId}/requests`,
      );
      console.log(JSON.stringify(peticiones.cuerpo, null, 2));
    }
  }

  console.log('\n── Errores DSA y cupo ──');
  console.log('Los códigos y subcódigos observados están en las respuestas de arriba. Si todas las copias pasaron sin error: los datos de DSA están cargados o la campaña no segmenta la UE, y las filas 190/17/100-cupo del catálogo de errores siguen sin confirmar.');

  process.exit(0);
}

main().catch((e) => {
  const m = e instanceof MetaAdsError ? `${e.message} (code ${e.code ?? '-'})` : e instanceof Error ? e.message : e;
  console.error('verificar-copies-ads falló:', m);
  process.exit(1);
});
