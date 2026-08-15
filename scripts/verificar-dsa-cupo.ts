/**
 * `npm run ads:dsa` — verifica contra la Marketing API en uso dos datos que el
 * preflight de duplicación necesita y que el diseño declara inciertos (D-03 y
 * D-04 del anexo): si `dsa_payor`/`dsa_beneficiary` son legibles en la edge de
 * conjuntos, y si la cuenta expone algún cupo de objetos legible. Se corre UNA
 * vez por versión de la Graph API (D-A16b); la salida alimenta las tasks 23.1
 * (lectura best-effort de DSA en el Sync_Jerarquia) y 23.2 (`verificarCupoObjetos`).
 *
 * QUÉ HACE Y EN QUÉ ORDEN
 * 1. DSA en la edge de conjuntos (`/{account}/adsets?fields=…,dsa_payor,
 *    dsa_beneficiary`): reporta si cada campo responde y un valor de ejemplo.
 * 2. DSA en la edge de anuncios (los mismos dos campos sobre un anuncio del
 *    primer conjunto): la referencia de la Marketing API los documenta a nivel
 *    anuncio, así que si la edge de conjuntos no los expone, esta segunda
 *    lectura dice dónde viven de verdad, que es lo que 23.1 necesita para no
 *    guardar basura en `ad_sets`.
 * 3. Cupo de objetos: lee el nodo de la cuenta y reporta si la respuesta trae
 *    alguna clave con pinta de tope (limit/cap/max). La API no documenta un
 *    campo de "máximo de objetos por cuenta": si no aparece nada, la conclusión
 *    esperada es "sin cupo legible" y `verificarCupoObjetos` usa el conteo
 *    local más `settings.ads_max_objetos_cuenta` (P-G06).
 *
 * LA ALLOWLIST NO ES UNA BÚSQUEDA
 * La cuenta sale de `ADS_TEST_ACCOUNT_ID`, igual que `verificar-campos-insights.ts`:
 * el script NO elige "la primera cuenta activa". Sin la variable no consulta
 * nada, lo dice en voz alta y sale con 0. Todo lo que hace es LEER: no crea ni
 * modifica ningún objeto de Meta.
 */

async function token(): Promise<string> {
  const t = process.env.META_ADS_TOKEN;
  if (!t) {
    console.error('FALTA META_ADS_TOKEN en el entorno');
    process.exit(1);
  }
  return t;
}

type ResultadoCampo = {
  campo: string;
  legible: boolean;
  detalle: string;
  ejemplo: string | null;
};

async function leer(
  t: string,
  apiVersion: string,
  url: string,
): Promise<{ ok: boolean; texto: string; datos: Array<Record<string, unknown>> }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, texto: e instanceof Error ? e.message : String(e), datos: [] };
  }
  const texto = await res.text();
  type Cuerpo = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string; code?: number };
  };
  let body: Cuerpo | null = null;
  try {
    body = JSON.parse(texto) as Cuerpo;
  } catch {
    body = null;
  }
  if (!res.ok || body?.error) {
    return {
      ok: false,
      texto: body?.error
        ? `${body.error.message ?? 'error de Meta'} (code ${body.error.code ?? '-'})`
        : `HTTP ${res.status}`,
      datos: [],
    };
  }
  return { ok: true, texto, datos: body?.data ?? [] };
}

async function main(): Promise<void> {
  const t = await token();
  const apiVersion = process.env.META_API_VERSION ?? 'v21.0';
  console.log(`Graph API: ${apiVersion}\n`);

  const accountId = process.env.ADS_TEST_ACCOUNT_ID;
  if (!accountId) {
    console.log('verificación no ejecutada: falta ADS_TEST_ACCOUNT_ID (allowlist)');
    console.log('  Agregá a .env el id de una cuenta publicitaria real (act_…), con el token con ads_read, y volvé a correr.');
    process.exit(0);
  }
  console.log(`cuenta: ${accountId}\n`);

  // ─── 1. DSA en la edge de conjuntos ────────────────────────────────────────
  console.log('── DSA en la edge de conjuntos ──');
  const conjuntos = await leer(
    t,
    apiVersion,
    `https://graph.facebook.com/${apiVersion}/${accountId}/adsets?fields=id,name,dsa_payor,dsa_beneficiary&limit=5`,
  );
  if (!conjuntos.ok) {
    console.log(`  adsets no respondió: ${conjuntos.texto}`);
  } else if (conjuntos.datos.length === 0) {
    console.log('  la cuenta no tiene conjuntos: no se pudo verificar');
  } else {
    for (const campo of ['dsa_payor', 'dsa_beneficiary']) {
      const conValor = conjuntos.datos.find((r) => campo in r);
      if (conValor) {
        console.log(`  ${campo}: LEGIBLE — ejemplo: ${String(conValor[campo] ?? 'null')}`);
      } else {
        console.log(`  ${campo}: no viene en la respuesta de /adsets (la edge no lo expone, o todos los valores están ausentes)`);
      }
    }
  }

  // ─── 2. DSA en la edge de anuncios (donde la API los documenta) ────────────
  console.log('\n── DSA en la edge de anuncios ──');
  if (conjuntos.ok && conjuntos.datos.length > 0) {
    const primerConjunto = conjuntos.datos[0]!;
    const idConjunto = String(primerConjunto.id ?? '');
    if (idConjunto) {
      const anuncios = await leer(
        t,
        apiVersion,
        `https://graph.facebook.com/${apiVersion}/${idConjunto}/ads?fields=id,name,dsa_payor,dsa_beneficiary&limit=1`,
      );
      if (!anuncios.ok) {
        console.log(`  ads no respondió: ${anuncios.texto}`);
      } else if (anuncios.datos.length === 0) {
        console.log('  el conjunto no tiene anuncios: no se pudo verificar');
      } else {
        for (const campo of ['dsa_payor', 'dsa_beneficiary']) {
          const fila = anuncios.datos[0]!;
          if (campo in fila) {
            console.log(`  ${campo}: LEGIBLE en /ads — ejemplo: ${String(fila[campo] ?? 'null')}`);
          } else {
            console.log(`  ${campo}: no viene en la respuesta de /ads`);
          }
        }
      }
    }
  } else {
    console.log('  salteado: sin conjuntos legibles para buscar un anuncio');
  }

  // ─── 3. Cupo de objetos de la cuenta ───────────────────────────────────────
  console.log('\n── Cupo de objetos ──');
  const cuenta = await leer(
    t,
    apiVersion,
    `https://graph.facebook.com/${apiVersion}/${accountId}?fields=id,name`,
  );
  if (!cuenta.ok) {
    console.log(`  el nodo de la cuenta no respondió: ${cuenta.texto}`);
    console.log('  conclusión: cupo remoto NO LEGIBLE → verificarCupoObjetos usa el conteo local y settings.ads_max_objetos_cuenta (P-G06)');
  } else {
    // La API no documenta un campo de "máximo de objetos por cuenta". Se reporta
    // lo que la respuesta efectivamente trae con pinta de tope, sin inventar un
    // nombre de campo que nadie confirmó.
    const claves = Object.keys(cuenta.datos[0] ?? {}).filter((k) => /limit|cap|max|cuota/i.test(k));
    if (claves.length === 0) {
      console.log('  la respuesta del nodo no trae ninguna clave con pinta de tope de objetos');
      console.log('  conclusión: cupo remoto NO LEGIBLE → verificarCupoObjetos usa el conteo local y settings.ads_max_objetos_cuenta (P-G06). La autoridad final sigue siendo el rechazo de Meta, mapeado en el catálogo de errores (R10 c13).');
    } else {
      for (const k of claves) {
        console.log(`  posible cupo: ${k} = ${String(cuenta.datos[0]![k])}`);
      }
      console.log('  conclusión: confirmar a mano qué significa cada clave antes de usarla como topeRemoto en verificarCupoObjetos.');
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('verificar-dsa-cupo falló:', e instanceof Error ? e.message : e);
  process.exit(1);
});
