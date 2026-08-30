/**
 * Sync de la jerarquía de anuncios de Meta (T14): campañas → conjuntos → anuncios.
 *
 * Llena y mantiene `ad_campaigns`, `ad_sets` y `ads` desde la Marketing API, de
 * forma idempotente y resistente a fallas parciales. No calcula métricas, no
 * evalúa reglas y no escribe nada en Meta: sólo lee la jerarquía y la guarda.
 *
 * POR QUÉ EXISTE (D-A4)
 * `ad_spend` solo tiene filas de objetos que gastaron ese día, y no tiene ni
 * estado ni presupuesto. Un conjunto pausado ayer no aparece hoy, así que sin
 * estas tablas no se puede listar ni reactivar. La jerarquía es el inventario;
 * `ad_spend` es el consumo.
 *
 * EL MODELO ES lib/ads/sync.ts
 * De ahí salen el manejo de errores por cuenta (una cuenta que falla no detiene
 * a las otras), el upsert idempotente por UNNEST y la forma del resultado.
 *
 * EL ORDEN IMPORTA: campañas → conjuntos → anuncios. Las FK van en esa
 * dirección, e insertar un conjunto antes que su campaña viola la FK y aborta
 * la transacción entera. Los tres niveles de una cuenta van en UNA transacción.
 *
 * NO SE BORRA NADA (P-A04, R3.5). Un objeto que Meta dejó de devolver se MARCA
 * en `desaparecido_at` (T6.1) y se queda con su `synced_at` viejo. Borrarlo
 * perdería el nombre, que es lo que hace legible el historial de `ad_actions`
 * semanas después, y perdería la fila a la que `ad_spend` le atribuye gasto
 * histórico. Cuando el objeto vuelve a aparecer, la marca se quita (R3.6).
 */

import { q, tx } from '../db';
import { fetchAds, fetchAdSets, fetchCampaigns, fetchCuenta, fetchDsaConjuntos, MetaAdsError } from './meta';
import { cuentasActivas, type CuentaSync } from './sync';
import type { DsaConjunto, MetaAd, MetaAdSet, MetaCampaign } from './tipos';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

export type ResultadoNivel = { traidos: number; guardados: number; huerfanos: number };

export type ResultadoCuenta = {
  accountId: string;
  name: string | null;
  campanias: ResultadoNivel;
  conjuntos: ResultadoNivel;
  anuncios: ResultadoNivel;
  /**
   * Cuántos objetos quedaron sin refrescar en esta corrida (§5), y por lo tanto
   * cuántos quedaron con `desaparecido_at` puesto (T6.1). Cuenta exactamente lo
   * que la marca escribe: un nivel que no se reconcilia
   * (ver `debeReconciliarDesaparecidos`) aporta 0, para que el reporte no
   * anuncie desapariciones que no se escribieron.
   */
  desaparecidos: number;
  /**
   * La moneda de la cuenta si NO es EUR, y por eso se salteó (D-A10, §4).
   * No es un error: es una cuenta fuera de alcance, y tiene que verse escrita.
   */
  monedaNoSoportada: string | null;
  /** Objetos con presupuesto TOTAL, que se listan pero no se automatizan (§4). */
  conPresupuestoLifetime: number;
  error: string | null;
};

export type ResultadoJerarquia = { cuentas: ResultadoCuenta[]; corridaAt: string };

/**
 * Regla de vigencia, idéntica para T15 y T17 (§5). Un objeto está vigente si se
 * refrescó en la última corrida exitosa de SU cuenta. El margen de 10 minutos
 * absorbe que los tres niveles se escriben en momentos ligeramente distintos.
 * La referencia es siempre el max(synced_at) de las CAMPAÑAS de la cuenta (el
 * primer nivel en escribirse), no de la tabla propia.
 *
 * `<tabla>` es el alias de la tabla que se está filtrando y hay que reemplazarlo
 * al pegar la cláusula (ej: `SQL_VIGENTE.replace('<tabla>', 'c')`). Es una
 * constante de string a propósito: no hay forma de que dos tasks la escriban
 * distinto por accidente.
 */
export const SQL_VIGENTE = `synced_at >= (
  SELECT max(c2.synced_at) - interval '10 minutes'
    FROM ad_campaigns c2 WHERE c2.account_id = <tabla>.account_id
)`;

/**
 * Dónde vive el presupuesto de una campaña. Meta no tiene un campo que lo diga:
 * se infiere. Cero es un valor, no la ausencia de uno (D-A5).
 */
export function inferirBudgetLevel(
  dailyBudget: number | null,
  lifetimeBudget: number | null,
): 'campaign' | 'adset' {
  return dailyBudget !== null || lifetimeBudget !== null ? 'campaign' : 'adset';
}

/**
 * Descarta los objetos cuyo padre no está en `idsPadre` y los cuenta. Se usa
 * para los conjuntos sin campaña y los anuncios sin conjunto (§5): un objeto
 * que apunta a un padre que no trajo esta corrida NI está en la base violaría
 * la FK y abortaría la transacción, así que se descarta en lugar de insertarlo.
 */
export function filtrarHuerfanos<T>(
  objetos: T[],
  idsPadre: ReadonlySet<string>,
  padreDe: (o: T) => string,
): { validos: T[]; huerfanos: number } {
  const validos: T[] = [];
  let huerfanos = 0;
  for (const o of objetos) {
    if (idsPadre.has(padreDe(o))) validos.push(o);
    else huerfanos += 1;
  }
  return { validos, huerfanos };
}

/**
 * Meta usa "0" como centinela de "sin presupuesto" en la edge de conjuntos: un
 * conjunto con presupuesto diario devuelve `lifetime_budget: "0"` al lado. Un
 * presupuesto de 0 unidades mínimas no existe (el piso es €0,87 = 87, P-A11),
 * así que 0 se normaliza a null al guardar, para no confundir a T15 (que deriva
 * budgetMode de estas columnas) ni el conteo de presupuestos TOTAL.
 *
 * Se aplica a los valores QUE SE GUARDAN. La inferencia de budget_level usa los
 * valores crudos, donde 0 sí cuenta como "tiene presupuesto" (es un valor, no
 * la ausencia de uno).
 */
export function normalizarPresupuestos(
  dailyBudget: number | null,
  lifetimeBudget: number | null,
): { dailyBudget: number | null; lifetimeBudget: number | null } {
  return {
    dailyBudget: dailyBudget === 0 ? null : dailyBudget,
    lifetimeBudget: lifetimeBudget === 0 ? null : lifetimeBudget,
  };
}

/**
 * Un conjunto de una campaña CBO no tiene presupuesto propio, aunque Meta
 * devuelva un valor heredado: el presupuesto vive en la campaña y escribir en
 * el conjunto falla. Si se guarda el heredado, el gestor muestra un presupuesto
 * editable donde no se puede editar (§4 punto 2).
 */
export function anularPresupuestoEnCBO(
  conjuntos: MetaAdSet[],
  campaniasCBO: ReadonlySet<string>,
): MetaAdSet[] {
  return conjuntos.map((s) =>
    campaniasCBO.has(s.campaignId) ? { ...s, dailyBudget: null, lifetimeBudget: null } : s,
  );
}

/**
 * Si un nivel de la Jerarquía se reconcilia contra la marca de desaparición en
 * esta corrida, dada la cantidad de objetos que Meta devolvió PARA ESE NIVEL.
 *
 * EL PELIGRO QUE EVITA. "Marcar todo lo que no vino" sólo es correcto si la
 * lista de lo que vino está completa. Un fallo duro nunca llega hasta acá: los
 * tres `fetch` salen en un mismo `Promise.all` y cualquier rechazo propaga hasta
 * el `catch` de `sincronizarJerarquia` ANTES de que `escribirCuenta` escriba una
 * sola fila, así que la cuenta entera queda sin tocar. Lo que sí llega es una
 * respuesta HTTP 200 con `data: []`: `paginar` la devuelve como lista vacía, sin
 * error, y con esa lista el UPDATE de la marca alcanzaría a la jerarquía COMPLETA
 * de la cuenta en una sola corrida.
 *
 * POR QUÉ LA DECISIÓN ES NO MARCAR. Una lista vacía admite dos lecturas —"la
 * cuenta se quedó sin objetos de este nivel" y "la lectura no trajo nada por un
 * problema transitorio"— y no hay nada en la respuesta que las distinga. Los
 * costos del error no son simétricos:
 *
 * - Marcar de más pone la advertencia sobre TODAS las filas de la cuenta, y con
 *   la advertencia previa a las escrituras (T15) sobre todas las acciones, por un
 *   problema que no existe. Una alarma que suena para todo no se lee más.
 * - No marcar deja las cosas como están hoy: los objetos siguen visibles con su
 *   `synced_at` viejo, que la tabla ya señala como dato viejo (T8), y la próxima
 *   corrida que traiga datos reconcilia. El error se corrige solo.
 *
 * El precio de la elección: una cuenta que de verdad se quedó sin objetos nunca
 * los marca, y quedan como "viejos" en lugar de "desaparecidos". Es el lado
 * barato del error, y las dos condiciones se muestran igual de visibles.
 *
 * La decisión es POR NIVEL y no por cuenta porque son tres llamadas distintas a
 * tres edges distintas de Meta: que la de conjuntos venga vacía no dice nada
 * sobre la de campañas.
 */
export function debeReconciliarDesaparecidos(cantidadTraida: number): boolean {
  return cantidadTraida > 0;
}

type CampaniaNivel = MetaCampaign & { budgetLevel: 'campaign' | 'adset' };

/**
 * Los ids que Meta devolvió en esta corrida, por nivel. Es la referencia con la
 * que se decide qué está presente y qué desapareció.
 *
 * Van SIN filtrar por huérfanos a propósito: un conjunto cuya campaña no está ni
 * en Meta ni en la base no se puede guardar (violaría la FK), pero Meta lo
 * devolvió, así que no desapareció. Marcarlo diría lo contrario de lo que pasó.
 * Queda con la marca en NULL y con el `synced_at` viejo, que es exactamente el
 * par de hechos que ocurrió: "Meta lo sigue devolviendo" y "no se pudo refrescar".
 */
type IdsTraidos = {
  campanias: readonly string[];
  conjuntos: readonly string[];
  anuncios: readonly string[];
};

/**
 * Trae la jerarquía completa de las cuentas activas y la guarda.
 * Idempotente: dos corridas seguidas dejan la base igual (upsert por PK).
 *
 * Además deja anotado por cuenta CUÁNDO terminó su corrida y con qué error, en
 * `ad_accounts.last_hierarchy_sync_at` / `last_hierarchy_sync_error` (T6.2,
 * R4.4 / R4.5). Ver `anotarCorrida` y el comentario del punto donde se llama.
 */
export async function sincronizarJerarquia(opts?: {
  cuentas?: string[]; // ausente = todas las activas de ad_accounts
  dryRun?: boolean;
}): Promise<ResultadoJerarquia> {
  const dryRun = opts?.dryRun ?? false;
  const activas = await cuentasActivas();
  const seleccion = opts?.cuentas?.length ? new Set(opts.cuentas) : null;
  const cuentas = seleccion ? activas.filter((c) => seleccion.has(c.accountId)) : activas;

  const out: ResultadoJerarquia = { cuentas: [], corridaAt: new Date().toISOString() };

  for (const cuenta of cuentas) {
    const r: ResultadoCuenta = {
      accountId: cuenta.accountId,
      name: cuenta.name,
      campanias: { traidos: 0, guardados: 0, huerfanos: 0 },
      conjuntos: { traidos: 0, guardados: 0, huerfanos: 0 },
      anuncios: { traidos: 0, guardados: 0, huerfanos: 0 },
      desaparecidos: 0,
      monedaNoSoportada: null,
      conPresupuestoLifetime: 0,
      error: null,
    };
    out.cuentas.push(r);
    try {
      await sincronizarCuenta(cuenta, dryRun, r);
    } catch (e) {
      r.error =
        e instanceof MetaAdsError
          ? `${e.message} (code ${e.code ?? '-'})`
          : e instanceof Error
            ? e.message
            : String(e);
    }

    // ── El reloj de la corrida (T6.2, R4.4 / R4.5) ───────────────────────────
    // ACÁ, y no dentro de la transacción de `escribirCuenta` como hace
    // `syncAdSpend` con el suyo, por tres razones:
    //
    // 1. TODOS LOS DESENLACES CONVERGEN EN ESTE PUNTO. `sincronizarCuenta`
    //    termina de tres maneras que no son la misma cosa —escribió la
    //    jerarquía, se salteó la cuenta por moneda, o falló— y sólo la primera
    //    pasa por `escribirCuenta`. Poniéndolo adentro harían falta tres sitios
    //    de escritura para un hecho que es uno solo ("esta corrida terminó
    //    así"), y tres oportunidades de que un desenlace nuevo se olvide de uno.
    //    Después del try/catch el desenlace ya está decidido y está en `r.error`.
    //
    // 2. LA ATOMICIDAD QUE SE PIERDE ES LA BARATA. Lo que no puede pasar es que
    //    el reloj avance sin que los datos estén: eso haría que la pantalla
    //    llame fresco a un dato viejo. Y no puede pasar, porque este UPDATE
    //    corre DESPUÉS del COMMIT de `escribirCuenta`. Lo que sí puede pasar es
    //    lo contrario —datos escritos y reloj sin avanzar, si el proceso muere
    //    entre los dos— y eso sólo hace que la cuenta se vea más atrasada de lo
    //    que está, hasta que la próxima corrida la vuelva a traer.
    //
    // 3. Como este `now()` es posterior al de la transacción, queda siempre
    //    `last_hierarchy_sync_at >= max(synced_at)` de las filas de la cuenta.
    //    Un `synced_at` posterior al fin de su propia corrida no significaría
    //    nada.
    //
    // EL DRY RUN NO ESCRIBE, y la guarda vive acá, en el único sitio que
    // escribe en `ad_accounts`: que una corrida en seco no toque nada se
    // verifica leyendo una línea, igual que la marca de desaparición se
    // verifica leyendo el `if (dryRun) return` de `sincronizarCuenta`.
    if (!dryRun) await anotarCorrida(cuenta.accountId, r.error);
  }

  return out;
}

/**
 * Anota el fin de la corrida de UNA cuenta: `last_hierarchy_sync_at = now()` y
 * el error al lado, o NULL si terminó bien (R4.4, R4.5).
 *
 * SE ESCRIBE TAMBIÉN CUANDO FALLA, igual que `syncAdSpend` con `last_sync_at`.
 * La columna no significa "cuándo se trajo la jerarquía por última vez" sino
 * "cuándo terminó el último intento", y eso importa por dos cosas:
 *
 * - El TTL de `ensureFreshJerarquia` (T9.1) se compara contra esta columna. Si
 *   una cuenta que falla nunca avanzara el reloj, cada pedido volvería a
 *   disparar el sync y el freno dejaría de frenar exactamente cuando Meta está
 *   rechazando llamadas, que es cuando más hace falta.
 * - El error va en la MISMA fila y se lee en la misma consulta que la hora
 *   (ver el comentario de `lib/ads/live.ts` para el gasto): sin el error al
 *   lado, una corrida fallida se leería como un dato fresco. Son las dos mitades
 *   de un solo hecho y ninguna se sostiene sola.
 *
 * Una corrida exitosa pasa `null` y con eso limpia el error que hubiera quedado
 * de una corrida anterior: el mismo UPDATE sirve para los dos casos.
 *
 * NO TIRA NUNCA. Es contabilidad sobre el resultado, y si falla no puede tapar
 * lo que pasó de verdad: el error de la cuenta ya está en `r.error` y viaja en
 * el resultado. Un fallo de esta escritura se loguea y la corrida sigue con la
 * cuenta siguiente.
 *
 * El recorte a 500 es el mismo de `syncAdSpend`: un error de Meta puede venir
 * con una página HTML entera adentro, y la columna la muestra /config en
 * pantalla.
 */
async function anotarCorrida(accountId: string, error: string | null): Promise<void> {
  try {
    await q(
      `UPDATE ad_accounts
          SET last_hierarchy_sync_at = now(),
              last_hierarchy_sync_error = $2
        WHERE account_id = $1`,
      [accountId, error === null ? null : error.slice(0, 500)],
    );
  } catch (e) {
    console.error(
      `ads jerarquía: no se pudo anotar la corrida de ${accountId} en ad_accounts:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function sincronizarCuenta(
  cuenta: CuentaSync,
  dryRun: boolean,
  r: ResultadoCuenta,
): Promise<void> {
  // D-A10: sólo cuentas en EUR. El dato de ad_accounts puede estar desactualizado
  // y no está verificado, así que además de mirarlo se consulta a Meta (fetchCuenta).
  //
  // ESTOS DOS RETURNS AVANZAN EL RELOJ DE LA CORRIDA IGUAL, con el error en NULL
  // (lo hace `anotarCorrida` desde el loop, porque `r.error` queda en null).
  // Es una decisión, no un descuido:
  //
  // - Saltear por moneda NO es un fallo, es una cuenta fuera de alcance, y la
  //   corrida para esa cuenta terminó bien: decidió correctamente que no hay
  //   nada que traer. Un reloj en NULL para siempre diría lo contrario.
  // - El lector de la frescura agrega con `min()` sobre las cuentas activas (así
  //   lo hace `lib/ads/live.ts` con el gasto y así lo hará T9.1 con la
  //   jerarquía): una sola cuenta sin reloj arrastra la barra de TODA la
  //   pantalla a "nunca sincronizado", y ninguna corrida podría arreglarlo
  //   nunca, porque el sync de esa cuenta es correcto al no traer nada. Sería
  //   un atraso permanente que no señala ningún problema, y una alarma que no se
  //   puede apagar deja de leerse (mismo argumento que
  //   `debeReconciliarDesaparecidos`).
  // - Por eso mismo el motivo del salteo NO va en `last_hierarchy_sync_error`:
  //   el error se agrega con `max()` entre cuentas, así que un texto ahí
  //   aparecería de forma permanente en la barra de todas. El "fuera de alcance"
  //   viaja donde corresponde, en `r.monedaNoSoportada`, que es el campo que el
  //   resultado tiene para eso y que el script de la corrida imprime.
  //
  // EL PRECIO: si Meta le cambia la moneda a una cuenta que ya tenía jerarquía,
  // el reloj de la cuenta va a decir "recién" sobre filas que dejaron de
  // refrescarse. Es el lado barato del error: esas filas conservan su propio
  // `synced_at`, que es el dato por fila con el que la tabla las marca como
  // viejas (T8), así que la condición sigue siendo visible donde importa.
  if (cuenta.currency != null && cuenta.currency !== MONEDA_REPORTE) {
    r.monedaNoSoportada = cuenta.currency;
    return;
  }
  const meta = await fetchCuenta(cuenta.accountId);
  if (meta.currency !== MONEDA_REPORTE) {
    r.monedaNoSoportada = meta.currency ?? 'desconocida';
    return;
  }

  // Las tres lecturas salen en paralelo: son independientes entre sí. La de DSA
  // es una lectura APARTE y best-effort (P-G01): si falla, la jerarquía se
  // sincroniza igual y dsa_checked_at queda en NULL = preflight inconcluso.
  const [campanias, conjuntos, anuncios, dsa] = await Promise.all([
    fetchCampaigns(cuenta.accountId),
    fetchAdSets(cuenta.accountId),
    fetchAds(cuenta.accountId),
    fetchDsaConjuntos(cuenta.accountId).catch((): DsaConjunto[] => []),
  ]);

  // Los que ya están en base, para decidir huérfanos y desaparecidos. El mapa
  // adset→campaña sirve para no confiar en el campaign_id desnormalizado de Meta
  // a nivel anuncio (verificación 3b).
  const [campExistentes, setExistentes, adExistentes] = await Promise.all([
    q<{ campaign_id: string }>('SELECT campaign_id FROM ad_campaigns WHERE account_id = $1', [
      cuenta.accountId,
    ]),
    q<{ adset_id: string; campaign_id: string }>(
      'SELECT adset_id, campaign_id FROM ad_sets WHERE account_id = $1',
      [cuenta.accountId],
    ),
    q<{ ad_id: string }>('SELECT ad_id FROM ads WHERE account_id = $1', [cuenta.accountId]),
  ]);

  const campTraidos = new Set(campanias.map((c) => c.campaignId));
  const setTraidos = new Set(conjuntos.map((s) => s.adsetId));
  const adTraidos = new Set(anuncios.map((a) => a.adId));

  const idsCampaniaValidos = new Set<string>(campTraidos);
  for (const x of campExistentes) idsCampaniaValidos.add(x.campaign_id);
  const idsConjuntoValidos = new Set<string>(setTraidos);
  for (const x of setExistentes) idsConjuntoValidos.add(x.adset_id);

  const conjFiltrados = filtrarHuerfanos(conjuntos, idsCampaniaValidos, (s) => s.campaignId);
  const adsFiltrados = filtrarHuerfanos(anuncios, idsConjuntoValidos, (a) => a.adsetId);

  // budget_level se calcula al guardar, no se lee de Meta (§4). La inferencia
  // usa los valores crudos (0 es un valor); lo que se guarda va normalizado
  // (0 → null, el centinela de Meta).
  const campaniasNivel: CampaniaNivel[] = campanias.map((c) => {
    const nivel = inferirBudgetLevel(c.dailyBudget, c.lifetimeBudget);
    const { dailyBudget, lifetimeBudget } = normalizarPresupuestos(c.dailyBudget, c.lifetimeBudget);
    return { ...c, budgetLevel: nivel, dailyBudget, lifetimeBudget };
  });
  const campaniasCBO = new Set(
    campaniasNivel.filter((c) => c.budgetLevel === 'campaign').map((c) => c.campaignId),
  );
  const conjuntosNormalizados = conjFiltrados.validos.map((s) => ({
    ...s,
    ...normalizarPresupuestos(s.dailyBudget, s.lifetimeBudget),
  }));
  const conjuntosFinales = anularPresupuestoEnCBO(conjuntosNormalizados, campaniasCBO);

  // El campaign_id de un anuncio sale del conjunto padre, no del campo de Meta:
  // garantiza coherencia entre ads.campaign_id y ad_sets.campaign_id.
  const adsetCampaign = new Map<string, string>();
  for (const x of setExistentes) adsetCampaign.set(x.adset_id, x.campaign_id);
  for (const s of conjuntosFinales) adsetCampaign.set(s.adsetId, s.campaignId);
  const anunciosFinales = adsFiltrados.validos.map((a) => ({
    ...a,
    campaignId: adsetCampaign.get(a.adsetId) ?? a.campaignId,
  }));

  r.campanias.traidos = campanias.length;
  r.campanias.guardados = dryRun ? 0 : campaniasNivel.length;
  r.campanias.huerfanos = 0; // las campañas no tienen padre
  r.conjuntos.traidos = conjuntos.length;
  r.conjuntos.guardados = dryRun ? 0 : conjuntosFinales.length;
  r.conjuntos.huerfanos = conjFiltrados.huerfanos;
  r.anuncios.traidos = anuncios.length;
  r.anuncios.guardados = dryRun ? 0 : anunciosFinales.length;
  r.anuncios.huerfanos = adsFiltrados.huerfanos;

  // Los ids crudos de Meta, que son los que deciden la marca de desaparición.
  // No los de las listas que se escriben (`conjuntosFinales`, `anunciosFinales`):
  // ésas ya pasaron por el filtro de huérfanos. Ver `IdsTraidos`.
  //
  // `Array.from` y no spread: el target de tsconfig pide --downlevelIteration
  // para iterar un Set, y el resto del repo ya resuelve así (ver
  // `lib/ads/reglas/coherencia.ts`).
  const idsTraidos: IdsTraidos = {
    campanias: Array.from(campTraidos),
    conjuntos: Array.from(setTraidos),
    anuncios: Array.from(adTraidos),
  };

  // Cuenta lo mismo que la marca escribe: un nivel que no se reconcilia no
  // afirma nada sobre desapariciones, ni en la base ni en el reporte.
  const faltantes = <T>(
    existentes: readonly T[],
    traidos: ReadonlySet<string>,
    idDe: (x: T) => string,
  ): number =>
    debeReconciliarDesaparecidos(traidos.size)
      ? existentes.filter((x) => !traidos.has(idDe(x))).length
      : 0;

  r.desaparecidos =
    faltantes(campExistentes, campTraidos, (x) => x.campaign_id) +
    faltantes(setExistentes, setTraidos, (x) => x.adset_id) +
    faltantes(adExistentes, adTraidos, (x) => x.ad_id);

  r.conPresupuestoLifetime =
    campaniasNivel.filter((c) => c.lifetimeBudget !== null).length +
    conjuntosFinales.filter((s) => s.lifetimeBudget !== null).length;

  // El dry run corta ACÁ, antes de la única función que escribe. La marca de
  // desaparición vive adentro de `escribirCuenta` justamente por eso: no hay
  // forma de que una corrida en seco toque `desaparecido_at`, del mismo modo que
  // hoy no toca los upserts.
  if (dryRun) return;

  await escribirCuenta(
    cuenta.accountId,
    campaniasNivel,
    conjuntosFinales,
    anunciosFinales,
    dsa.length > 0 ? dsa : null,
    idsTraidos,
  );
}

/**
 * Los tres niveles con su tabla y su PK, en el orden en que se escriben. Mismo
 * par que ya usan `lib/ads/acciones.ts` y `lib/ads/reglas/repo.ts`. Son
 * constantes de código y nunca entrada del usuario, así que interpolarlas en el
 * SQL no abre inyección; los ids, que sí vienen de Meta, van por `$n`.
 */
const NIVELES_MARCA = [
  { tabla: 'ad_campaigns', pk: 'campaign_id', campo: 'campanias' },
  { tabla: 'ad_sets', pk: 'adset_id', campo: 'conjuntos' },
  { tabla: 'ads', pk: 'ad_id', campo: 'anuncios' },
] as const satisfies ReadonlyArray<{ tabla: string; pk: string; campo: keyof IdsTraidos }>;

async function escribirCuenta(
  accountId: string,
  campanias: CampaniaNivel[],
  conjuntos: MetaAdSet[],
  anuncios: MetaAd[],
  dsa: DsaConjunto[] | null,
  idsTraidos: IdsTraidos,
): Promise<void> {
  // DSA best-effort (P-G01): si la lectura trajo filas, se guardan y
  // dsa_checked_at marca la verificación; si no trajo (o falló), dsa_checked_at
  // queda NULL = inconcluso, y el preflight lo informa así.
  const dsaPorId = new Map((dsa ?? []).map((d) => [d.adsetId, d]));
  const dsaCheckedAt = dsa === null ? null : new Date();

  await tx(async (cl) => {
    if (campanias.length) {
      await cl.query(
        `INSERT INTO ad_campaigns (campaign_id, account_id, name, objective, status,
                                   effective_status, budget_level, daily_budget,
                                   lifetime_budget, currency, bid_strategy,
                                   created_time, start_time, end_time, synced_at)
         SELECT u.id, $1, u.name, u.objective, u.status, u.effective_status,
                u.budget_level, u.daily_budget, u.lifetime_budget, $2, u.bid_strategy,
                NULLIF(u.created_time, '')::timestamptz,
                NULLIF(u.start_time, '')::timestamptz, NULLIF(u.end_time, '')::timestamptz,
                now()
           FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::bigint[], $10::bigint[], $11::text[], $12::text[],
                       $13::text[], $14::text[])
                AS u(id, name, objective, status, effective_status,
                     budget_level, daily_budget, lifetime_budget, bid_strategy,
                     created_time, start_time, end_time)
         ON CONFLICT (campaign_id) DO UPDATE SET
           name = EXCLUDED.name,
           objective = EXCLUDED.objective,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           budget_level = EXCLUDED.budget_level,
           daily_budget = EXCLUDED.daily_budget,
           lifetime_budget = EXCLUDED.lifetime_budget,
           bid_strategy = EXCLUDED.bid_strategy,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           synced_at = now()`,
        [
          accountId,
          MONEDA_REPORTE,
          campanias.map((c) => c.campaignId),
          campanias.map((c) => c.name),
          campanias.map((c) => c.objective),
          campanias.map((c) => c.status),
          campanias.map((c) => c.effectiveStatus),
          campanias.map((c) => c.budgetLevel),
          campanias.map((c) => c.dailyBudget),
          campanias.map((c) => c.lifetimeBudget),
          campanias.map((c) => c.bidStrategy),
          campanias.map((c) => c.createdTime),
          campanias.map((c) => c.startTime),
          campanias.map((c) => c.endTime),
        ],
      );
    }

    if (conjuntos.length) {
      await cl.query(
        `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status,
                              effective_status, daily_budget, lifetime_budget,
                              currency, optimization_goal, billing_event,
                              bid_strategy, created_time, start_time, end_time,
                              dsa_payor, dsa_beneficiary, dsa_checked_at, synced_at)
         SELECT u.id, u.campaign_id, $1, u.name, u.status, u.effective_status,
                u.daily_budget, u.lifetime_budget, $2, u.optimization_goal,
                u.billing_event, u.bid_strategy,
                NULLIF(u.created_time, '')::timestamptz,
                NULLIF(u.start_time, '')::timestamptz, NULLIF(u.end_time, '')::timestamptz,
                u.dsa_payor, u.dsa_beneficiary, $3::timestamptz, now()
           FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                       $9::bigint[], $10::bigint[], $11::text[], $12::text[],
                       $13::text[], $14::text[], $15::text[], $16::text[],
                       $17::text[], $18::text[])
                AS u(id, campaign_id, name, status, effective_status,
                     daily_budget, lifetime_budget, optimization_goal,
                     billing_event, bid_strategy, created_time, start_time, end_time,
                     dsa_payor, dsa_beneficiary)
         ON CONFLICT (adset_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           daily_budget = EXCLUDED.daily_budget,
           lifetime_budget = EXCLUDED.lifetime_budget,
           optimization_goal = EXCLUDED.optimization_goal,
           billing_event = EXCLUDED.billing_event,
           bid_strategy = EXCLUDED.bid_strategy,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           dsa_payor = EXCLUDED.dsa_payor,
           dsa_beneficiary = EXCLUDED.dsa_beneficiary,
           dsa_checked_at = EXCLUDED.dsa_checked_at,
           synced_at = now()`,
        [
          accountId,
          MONEDA_REPORTE,
          dsaCheckedAt,
          conjuntos.map((s) => s.adsetId),
          conjuntos.map((s) => s.campaignId),
          conjuntos.map((s) => s.name),
          conjuntos.map((s) => s.status),
          conjuntos.map((s) => s.effectiveStatus),
          conjuntos.map((s) => s.dailyBudget),
          conjuntos.map((s) => s.lifetimeBudget),
          conjuntos.map((s) => s.optimizationGoal),
          conjuntos.map((s) => s.billingEvent),
          conjuntos.map((s) => s.bidStrategy),
          conjuntos.map((s) => s.createdTime),
          conjuntos.map((s) => s.startTime),
          conjuntos.map((s) => s.endTime),
          conjuntos.map((s) => dsaPorId.get(s.adsetId)?.dsaPayor ?? null),
          conjuntos.map((s) => dsaPorId.get(s.adsetId)?.dsaBeneficiary ?? null),
        ],
      );
    }

    if (anuncios.length) {
      await cl.query(
        `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status,
                          effective_status, creative_id, created_time, synced_at)
         SELECT u.id, u.adset_id, u.campaign_id, $1, u.name, u.status,
                u.effective_status, u.creative_id,
                NULLIF(u.created_time, '')::timestamptz, now()
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                       $7::text[], $8::text[], $9::text[])
                AS u(id, adset_id, campaign_id, name, status, effective_status,
                     creative_id, created_time)
         ON CONFLICT (ad_id) DO UPDATE SET
           adset_id = EXCLUDED.adset_id,
           campaign_id = EXCLUDED.campaign_id,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           creative_id = EXCLUDED.creative_id,
           synced_at = now()`,
        [
          accountId,
          anuncios.map((a) => a.adId),
          anuncios.map((a) => a.adsetId),
          anuncios.map((a) => a.campaignId),
          anuncios.map((a) => a.name),
          anuncios.map((a) => a.status),
          anuncios.map((a) => a.effectiveStatus),
          anuncios.map((a) => a.creativeId),
          anuncios.map((a) => a.createdTime),
        ],
      );
    }

    // ── La marca de desaparición (T6.1, R3.2 / R3.5 / R3.6) ──────────────────
    // Va DENTRO de esta misma transacción, y eso es lo que importa: en dos
    // transacciones separadas, un corte entre ellas dejaría objetos marcados como
    // desaparecidos que el upsert acababa de confirmar, y la pantalla advertiría
    // sobre datos que están bien. Con una sola, o queda todo o no queda nada.
    //
    // Va DESPUÉS de los upserts sólo por narrativa (primero lo que Meta dijo,
    // después lo que no dijo): las dos escrituras son independientes, porque los
    // conjuntos de filas se deciden por los ids traídos y no por `synced_at`.
    //
    // `now()` en Postgres es el instante de INICIO de la transacción, no de cada
    // statement, así que el `desaparecido_at` que se escribe acá es exactamente el
    // mismo instante que el `synced_at` de arriba: una corrida, una marca de
    // tiempo, sin deriva entre niveles.
    //
    // No hay DELETE en ninguna rama (R3.5): la cantidad de filas por cuenta sólo
    // puede crecer (Property 6).
    for (const nivel of NIVELES_MARCA) {
      const ids = idsTraidos[nivel.campo];
      if (!debeReconciliarDesaparecidos(ids.length)) continue;

      // (a) MARCAR lo que no vino. `desaparecido_at IS NULL` no es una
      // optimización: es lo que hace que la marca signifique "desde cuándo".
      // Un objeto que falta cinco corridas seguidas conserva la fecha de la
      // PRIMERA en que faltó (Property 5); sin la guarda, cada corrida
      // re-estamparía `now()` y la columna diría "hace 15 minutos" de algo que
      // no se ve desde hace cinco días, que es justo el dato que el gestor
      // necesita mostrar.
      await cl.query(
        `UPDATE ${nivel.tabla}
            SET desaparecido_at = now()
          WHERE account_id = $1
            AND desaparecido_at IS NULL
            AND ${nivel.pk} <> ALL($2::text[])`,
        [accountId, ids],
      );

      // (b) DESMARCAR lo que volvió (R3.6). La condición sobre el valor previo no
      // cambia el resultado —escribir NULL sobre NULL no cambia nada— pero evita
      // reescribir todas las filas de las tres tablas en cada corrida del cron:
      // serían miles de tuplas muertas cada 15 minutos, para autovacuum, por
      // updates que no cambian ningún valor.
      await cl.query(
        `UPDATE ${nivel.tabla}
            SET desaparecido_at = NULL
          WHERE account_id = $1
            AND desaparecido_at IS NOT NULL
            AND ${nivel.pk} = ANY($2::text[])`,
        [accountId, ids],
      );
    }
  });
}
