/**
 * `npm run ads:campos` — verifica contra la Marketing API en uso cuáles de los
 * campos nuevos de Insights responden y cuáles no (R7 c12, cierra la mitad de
 * D-02/D-03 que toca a Insights). Se corre UNA vez por versión de la Graph API
 * (D-A16b): la salida alimenta las tasks 13.1 y 13.2 (campos de video en el
 * sync), 14.1 (`fetchAlcance`) y confirma `campoApi`/`retiroAnunciado` de las
 * entradas del `Catalogo_Metricas`.
 *
 * QUÉ HACE Y EN QUÉ ORDEN
 * 1. Lee el token (`META_ADS_TOKEN`) y la versión (`META_API_VERSION`) y los
 *    imprime, igual que `verificar-token-ads.ts`.
 * 2. Pide una lectura de Insights por CADA campo candidato, una fila sola
 *    (`limit=1`), sin `time_increment` (reach/frequency exigen rango completo y
 *    los campos de video llegan como desglose por tipo de acción de todas
 *    formas). Pedir todos juntos haría que un campo no soportado tire el pedido
 *    entero y no se sabría cuál falló: de a uno, la respuesta dice exactamente
 *    cuál responde.
 * 3. Reporta por campo: respondió (y en qué forma), no respondió (con el código
 *    y mensaje de Meta), o no se pudo verificar porque la cuenta no tiene filas
 *    en el rango. Si la respuesta trae un aviso de retiro (deprecation), se
 *    reporta; si no, se dice que la respuesta no lo anuncia.
 *
 * LA ALLOWLIST NO ES UNA BÚSQUEDA
 * La cuenta sale de `ADS_TEST_ACCOUNT_ID`, con el mismo criterio que
 * `verificar-token-ads.ts` con `ADS_TEST_OBJECT_ID`: el script NO elige "la
 * primera cuenta activa" ni la de la lista. Sin la variable no consulta nada,
 * lo dice en voz alta y sale con 0 (no es un fallo del token, es configuración
 * que falta).
 */

import { q1 } from '../lib/db';

const CAMPOS = [
  'video_play_actions',
  'video_thruplay_watched_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
  'reach',
  'frequency',
] as const;

function token(): string {
  const t = process.env.META_ADS_TOKEN;
  if (!t) {
    console.error('FALTA META_ADS_TOKEN en el entorno');
    process.exit(1);
  }
  return t;
}

type ResultadoCampo = {
  campo: string;
  estado: 'responde' | 'no_responde' | 'sin_datos';
  detalle: string;
  avisoRetiro: boolean;
};

async function probarCampo(
  t: string,
  apiVersion: string,
  accountId: string,
  desde: string,
  hasta: string,
  campo: string,
): Promise<ResultadoCampo> {
  const timeRange = encodeURIComponent(JSON.stringify({ since: desde, until: hasta }));
  const url =
    `https://graph.facebook.com/${apiVersion}/${accountId}/insights` +
    `?level=ad&fields=impressions,${campo}&time_range=${timeRange}&limit=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      campo,
      estado: 'no_responde',
      detalle: `error de red o timeout: ${e instanceof Error ? e.message : String(e)}`,
      avisoRetiro: false,
    };
  }

  const texto = await res.text();
  type CuerpoInsights = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string; code?: number };
  };
  let body: CuerpoInsights | null = null;
  try {
    body = JSON.parse(texto) as CuerpoInsights;
  } catch {
    body = null;
  }

  const avisoRetiro = /deprecat/i.test(texto);

  if (!res.ok || body?.error) {
    return {
      campo,
      estado: 'no_responde',
      detalle: body?.error
        ? `${body.error.message ?? 'error de Meta'} (code ${body.error.code ?? '-'})`
        : `HTTP ${res.status}`,
      avisoRetiro,
    };
  }

  const fila = body?.data?.[0];
  if (!fila) {
    return {
      campo,
      estado: 'sin_datos',
      detalle: 'la cuenta no devolvió filas de Insights para el rango pedido: no se pudo verificar',
      avisoRetiro,
    };
  }

  // reach/frequency vienen como número o string plano; los campos de video
  // llegan como desglose por tipo de acción: [{action_type, value}].
  if (campo in fila) {
    const v = fila[campo];
    const forma = Array.isArray(v) ? 'desglose por tipo de acción' : 'valor plano';
    return { campo, estado: 'responde', detalle: forma, avisoRetiro };
  }
  return {
    campo,
    estado: 'sin_datos',
    detalle: 'la fila no trae el campo (la cuenta puede no tener datos de video en el rango): no se pudo verificar',
    avisoRetiro,
  };
}

async function main(): Promise<void> {
  const t = token();
  const apiVersion = process.env.META_API_VERSION ?? 'v21.0';
  console.log(`Graph API: ${apiVersion}\n`);

  const accountId = process.env.ADS_TEST_ACCOUNT_ID;
  if (!accountId) {
    console.log('verificación no ejecutada: falta ADS_TEST_ACCOUNT_ID (allowlist)');
    console.log('  Agregá a .env el id de una cuenta publicitaria real (act_…), con el token con ads_read, y volvé a correr.');
    console.log('  El script NO elige la primera cuenta de la lista a propósito: lee la cuenta que le digan.');
    process.exit(0);
  }

  // El rango se resuelve en Postgres (lib/day.ts): la aritmética de fechas en
  // JS corre un día en el horario de verano. Zona de la cuenta si se conoce,
  // el default de T15 si no.
  const zona = await q1<{ tz: string }>(
    `SELECT COALESCE(timezone, 'Europe/Lisbon') AS tz
       FROM ad_accounts WHERE account_id = $1`,
    [accountId],
  ).then((r) => r?.tz ?? 'Europe/Lisbon');
  const rango = await q1<{ desde: string; hasta: string }>(
    `SELECT (now() AT TIME ZONE $1 - interval '6 days')::date::text AS desde,
            (now() AT TIME ZONE $1)::date::text AS hasta`,
    [zona],
  );
  const desde = rango?.desde ?? '1970-01-01';
  const hasta = rango?.hasta ?? '1970-01-01';
  console.log(`cuenta: ${accountId} · zona: ${zona} · rango: ${desde}..${hasta}\n`);

  let responden = 0;
  for (const campo of CAMPOS) {
    const r = await probarCampo(t, apiVersion, accountId, desde, hasta, campo);
    if (r.estado === 'responde') responden += 1;
    const marca = r.estado === 'responde' ? 'OK' : r.estado === 'no_responde' ? 'NO RESPONDE' : 'SIN DATOS';
    console.log(`${marca.padEnd(11)} ${campo.padEnd(32)} ${r.detalle}`);
    if (r.avisoRetiro) {
      console.log(`            ⚠ ${campo}: la respuesta trae un aviso de retiro (deprecation)`);
    }
  }

  console.log(
    `\n${responden} de ${CAMPOS.length} campos responden en ${apiVersion} para la cuenta ${accountId}.`,
  );
  console.log('Si un campo NO RESPONDE, su columna del Catalogo_Metricas va a mostrar — (campo ausente), y el hook rate NO cae a la vista de 3 segundos en silencio (P-G02).');
  process.exit(0);
}

main().catch((e) => {
  console.error('verificar-campos-insights falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
