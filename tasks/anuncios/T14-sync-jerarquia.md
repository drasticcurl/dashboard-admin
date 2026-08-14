# T14 — Sync de la jerarquía: campañas, conjuntos y anuncios

- **Depende de:** T13 (la migración 016, `lib/ads/tipos.ts` y los lectores de `lib/ads/meta.ts`).
- **Bloquea:** T17 (el gestor no puede listar objetos que no están en la base).
- **Se puede correr en paralelo con:** T15 y T16.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** los de la fila T14 de §8 del plan
  (`lib/ads/jerarquia.ts`, `lib/ads/jerarquia.test.ts`, `scripts/sync-ads-jerarquia.ts`). Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo. El §6 es el contrato del cliente de Meta que ya escribió T13 y que
este task consume sin modificar.

---

## 1. Objetivo

Llenar y mantener `ad_campaigns`, `ad_sets` y `ads` desde la Marketing API, de forma idempotente y
resistente a fallas parciales.

Este task **no calcula métricas, no evalúa reglas y no escribe nada en Meta.** Solo lee la jerarquía y
la guarda.

**Por qué existe.** `ad_spend` solo tiene filas de objetos que gastaron ese día, y no tiene ni estado
ni presupuesto. Un conjunto pausado ayer no aparece hoy, así que sin esta tabla no se puede listar ni
reactivar, y la regla "Activar todas a las 0 horas a ver cómo rinden" del usuario es imposible de
implementar. La jerarquía es el **inventario**; `ad_spend` es el **consumo** (D-A4).

## 2. `lib/ads/jerarquia.ts`

El modelo es `lib/ads/sync.ts`, que ya hace esto mismo para el gasto y está probado en producción.
**Leelo completo antes de escribir**: de ahí salen el manejo de errores por cuenta, el upsert por
`UNNEST` y la forma del resultado. No lo modifiques.

```ts
export type ResultadoNivel = { traidos: number; guardados: number; huerfanos: number };

export type ResultadoCuenta = {
  accountId: string;
  name: string | null;
  campanias: ResultadoNivel;
  conjuntos: ResultadoNivel;
  anuncios: ResultadoNivel;
  /** Cuántos objetos quedaron sin refrescar en esta corrida (§5). */
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
 * Trae la jerarquía completa de las cuentas activas y la guarda.
 * Idempotente: dos corridas seguidas dejan la base igual.
 */
export async function sincronizarJerarquia(opts?: {
  cuentas?: string[];        // ausente = todas las activas de ad_accounts
  dryRun?: boolean;
}): Promise<ResultadoJerarquia>;

/** Los ids que el gestor y las reglas consideran vigentes hoy. Ver §5. */
export const SQL_VIGENTE: string;
```

**Una cuenta que falla no detiene a las otras.** Mismo criterio que `syncAdSpend`: el error se guarda
en el resultado y la corrida sigue con la cuenta siguiente. Con dos cuentas, que una tenga el token
mal asignado no puede dejar el gestor vacío.

**El orden importa y no es negociable: campañas → conjuntos → anuncios.** Las FK van en esa dirección
(`ad_sets.campaign_id` → `ad_campaigns`, `ads.adset_id` → `ad_sets`). Insertar un conjunto antes que
su campaña viola la FK y aborta la transacción entera.

## 3. El upsert: un round-trip por nivel y por cuenta

Copiá el patrón de `syncAdSpend`: un solo `INSERT ... SELECT FROM UNNEST(...)` con
`ON CONFLICT DO UPDATE` por nivel. Una cuenta con 300 anuncios de a uno son 300 round-trips; con
`UNNEST` es uno.

Los conflictos van contra la PK de cada tabla (`campaign_id`, `adset_id`, `ad_id`), y el `DO UPDATE`
pisa **todos** los campos mutables más `synced_at = now()`. Lo que nunca se pisa es la PK y
`created_time` (que es de Meta y no cambia).

```sql
INSERT INTO ad_campaigns (campaign_id, account_id, name, objective, status, effective_status,
                          budget_level, daily_budget, lifetime_budget, currency, bid_strategy,
                          created_time, synced_at)
SELECT u.id, $1, u.name, u.objective, u.status, u.effective_status,
       u.budget_level, u.daily_budget, u.lifetime_budget, $2, u.bid_strategy,
       u.created_time, now()
  FROM UNNEST($3::text[], $4::text[], ...) AS u(id, name, ...)
ON CONFLICT (campaign_id) DO UPDATE SET
  name = EXCLUDED.name, status = EXCLUDED.status,
  effective_status = EXCLUDED.effective_status,
  budget_level = EXCLUDED.budget_level,
  daily_budget = EXCLUDED.daily_budget, lifetime_budget = EXCLUDED.lifetime_budget,
  bid_strategy = EXCLUDED.bid_strategy, synced_at = now();
```

**`account_id` y `currency` van como parámetro escalar, no como array.** Son constantes dentro de la
cuenta y repetirlas 300 veces en un array es ruido.

**Los tres niveles de una cuenta van en UNA transacción** (`tx()` de `lib/db.ts`). Si los anuncios
fallan a mitad de camino, no queremos la mitad de la jerarquía escrita con conjuntos que apuntan a
campañas que sí entraron pero anuncios que no: el gestor mostraría un árbol incompleto sin avisar.

## 4. `budget_level`: la inferencia CBO vs ABO

Es el dato que decide **a qué id se le pega** cuando una regla cambia el presupuesto, y adivinarlo
mal es la primera causa de acciones fallidas (D-A5).

Meta no tiene un campo que lo diga. Se infiere:

```
la campaña trae daily_budget o lifetime_budget con valor  →  budget_level = 'campaign'   (CBO)
los dos vienen en null                                    →  budget_level = 'adset'      (ABO)
```

Con `'campaign'`, escribir presupuesto en un conjunto de esa campaña **falla**: Meta devuelve un error
de validación. Con `'adset'`, escribir en la campaña falla igual.

Tres consecuencias para este task:

1. `ad_campaigns.budget_level` se calcula al guardar, no se lee de Meta.
2. **Un conjunto de una campaña CBO se guarda con `daily_budget = NULL`**, aunque Meta devuelva un
   valor heredado. Si se guarda el heredado, el gestor muestra un presupuesto editable en un conjunto
   donde no se puede editar, y la regla intenta escribirlo y falla en cada corrida.
3. **`budget_level` NO alcanza: hay que distinguir DIARIO de TOTAL.** Ver el punto siguiente.

### `daily` vs `lifetime`: dos cosas que la inferencia de arriba mete en la misma bolsa

La inferencia dice `'campaign'` tanto si vino `daily_budget` como si vino `lifetime_budget`. Pero lo
**único** que este módulo sabe escribir es `setDailyBudget` (D-A10). Así que un CBO con presupuesto total
quedaba marcado como "el presupuesto vive en la campaña", el gestor lo mostraba editable, y cada corrida
de una regla de presupuesto le mandaba un `daily_budget` que Meta rechaza. El síntoma es una regla que
falla siempre con un error de validación que no explica la causa.

La distinción va explícita, y de ahí sale el `budgetMode` del contrato (§4 del plan):

```
daily_budget con valor      →  budgetMode = 'daily'      ← se puede editar y automatizar
lifetime_budget con valor   →  budgetMode = 'lifetime'   ← se MUESTRA, no se edita
los dos en null             →  budgetMode = null         ← este nivel no lo maneja
```

Si vinieran los dos con valor (no debería pasar; Meta usa uno u otro), gana `lifetime` y se anota: es la
lectura conservadora, porque deja el objeto fuera de la automatización en lugar de dentro.

**No se convierte un presupuesto total en diario.** Cambia cómo entrega la campaña y nadie lo pidió.

### Cuentas que no facturan en EUR no se sincronizan

`fetchCuenta` (T13 §5) devuelve `currency`. **Si no es `EUR`, la cuenta se saltea**, se reporta en el
resultado y el script sigue con las demás (D-A10). Todo el contrato de este módulo dice `Eur` y la UI
multiplica por 100 sin mirar la moneda: con una cuenta en otra moneda eso escribe un importe equivocado
**sin ningún error**, que es la peor forma de estar mal.

Agregá `monedaNoSoportada: string | null` a `ResultadoCuenta` para que el script lo pueda imprimir. No es
un error de la corrida: es una cuenta fuera de alcance, y hay que verlo escrito en lugar de deducirlo de
que no aparece.

## 5. Objetos que Meta ya no devuelve — no se borran

P-A04 del plan, resuelto en lo conservador: **este task no borra nada.**

Un objeto que Meta dejó de devolver (se archivó, se borró, cambió de cuenta) simplemente no se
refresca, así que su `synced_at` queda atrás. Borrarlo perdería el nombre, y el nombre es lo que hace
legible el historial de `ad_actions` semanas después.

La regla de vigencia, que **T15 y T17 tienen que usar idéntica** (está también en T15 §6):

```sql
-- Un objeto está vigente si se refrescó en la última corrida exitosa de su
-- cuenta. El margen de 10 minutos absorbe que los tres niveles se escriben en
-- momentos ligeramente distintos y que una corrida puede tardar.
synced_at >= (
  SELECT max(c2.synced_at) - interval '10 minutes'
    FROM ad_campaigns c2 WHERE c2.account_id = <tabla>.account_id
)
```

Exportala como `SQL_VIGENTE` para que los otros tasks la puedan pegar en su `WHERE` sin volver a
razonarla. Es una constante de string, no una función: no hay forma de que dos tasks la escriban
distinto por accidente.

**Ojo con `/campaigns` y los archivados.** Según el filtro que se use, Meta puede no devolver las
campañas archivadas, y entonces sus conjuntos llegan por `/adsets` sin campaña padre en la base. Eso es
una violación de FK que aborta la transacción de esa cuenta. **No se resuelve pidiendo los archivados**
(que traen basura de años): se resuelve **descartando el huérfano y contándolo**:

```
por cada conjunto: si su campaign_id no está en el set de campañas que trajo esta corrida
                   ni en ad_campaigns → NO se inserta, y se suma a huerfanos
por cada anuncio:  ídem contra los conjuntos
```

`huerfanos > 0` no es un error: es información y va en el resultado y en la salida del script. Un
número que crece con el tiempo sí es una señal de que algo hay que mirar.

## 6. `scripts/sync-ads-jerarquia.ts`

```
npm run ads:jerarquia                        # todas las cuentas activas
npm run ads:jerarquia -- --cuenta=act_123    # una sola
npm run ads:jerarquia -- --dry-run           # trae y cuenta, no escribe
```

Sigue el molde de `scripts/sync-ads.ts`, que ya existe: parseo simple de flags, salida legible por
cuenta, y **exit 1 si alguna cuenta falló** (así se puede encadenar en `deploy.sh` y en el cron).

La salida imprime, por cuenta y por nivel: traídos, guardados, huérfanos, y al final los
desaparecidos. Nada de volcar los objetos: son cientos.

**Este script no va al cron en este task.** La línea la agrega T18 junto con el resto del deploy, para
que un solo task sea dueño de `deploy/cron.panel` (§8 del plan).

## 7. Tests

`lib/ads/jerarquia.test.ts`, con `vitest`, co-ubicado como el resto del proyecto.

Lo que hay que probar son las **funciones puras**, sin red y sin base. Extraé la lógica que decide en
funciones exportadas y testeálas:

1. **`inferirBudgetLevel`** — campaña con `daily_budget` → `'campaign'`; con `lifetime_budget` →
   `'campaign'`; con los dos en `null` → `'adset'`. Y `daily_budget: 0` → `'campaign'` también: cero es
   un valor, no la ausencia de uno.
2. **`filtrarHuerfanos`** — un conjunto cuyo `campaignId` no está en el set se descarta y se cuenta; el
   resto pasa. Con el set vacío, todos son huérfanos y no tira.
3. **El presupuesto de un conjunto en una campaña CBO se anula** (§4 punto 2).

Los tests que necesitan `DATABASE_URL` se saltan con `it.skip` cuando no está, como en
`lib/day.test.ts`. **No los borres para que pase el build.**

## 8. Verificación

Nada de esto es opcional.

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — el dry-run trae datos y no escribe nada
docker exec panel-db-1 psql -U panel -d panel -tAc "SELECT count(*) FROM ad_campaigns;"
npm run ads:jerarquia -- --dry-run
docker exec panel-db-1 psql -U panel -d panel -tAc "SELECT count(*) FROM ad_campaigns;"
# los dos conteos tienen que ser IDÉNTICOS, y el dry-run tiene que reportar traidos > 0

# 3 — el sync real llena los tres niveles
npm run ads:jerarquia
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT 'campanias' t, count(*) FROM ad_campaigns
   UNION ALL SELECT 'conjuntos', count(*) FROM ad_sets
   UNION ALL SELECT 'anuncios',  count(*) FROM ads;"
# los tres tienen que ser > 0.
#
# `anuncios >= conjuntos >= campanias` NO es un invariante y NO es criterio de
# aprobación: una campaña puede existir sin conjuntos y un conjunto sin anuncios,
# y eso es normal en una cuenta real. Es una OBSERVACIÓN útil: si la relación se
# invierte fuerte, mirá la paginación (verificación 5, que sí es concluyente).

# 3b — LO QUE SÍ ES INVARIANTE: integridad referencial y unicidad.
#      Esto es lo que hay que exigir, y la base ya lo garantiza con las FK, así
#      que si alguna de estas devuelve > 0 hay un bug en el orden de inserción.
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT 'conjuntos sin campaña' q, count(*) FROM ad_sets s
     WHERE NOT EXISTS (SELECT 1 FROM ad_campaigns c WHERE c.campaign_id = s.campaign_id)
   UNION ALL
   SELECT 'anuncios sin conjunto', count(*) FROM ads a
     WHERE NOT EXISTS (SELECT 1 FROM ad_sets s WHERE s.adset_id = a.adset_id)
   UNION ALL
   SELECT 'campaign_id incoherente en ads', count(*) FROM ads a
     JOIN ad_sets s USING (adset_id) WHERE a.campaign_id <> s.campaign_id
   UNION ALL
   SELECT 'status fuera del vocabulario', count(*) FROM ad_campaigns
     WHERE status IS NOT NULL
       AND status NOT IN ('ACTIVE','PAUSED','ARCHIVED','DELETED');"
# esperado exactamente: 0 en las cuatro.
# La tercera es la que atrapa un desnormalizado mal copiado, que después hace que
# la UI baje de campaña a conjuntos y no encuentre nada.

# 4 — ES IDEMPOTENTE: la segunda corrida no crea filas nuevas
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_campaigns" > /tmp/antes.txt
npm run ads:jerarquia
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_campaigns" > /tmp/despues.txt
diff /tmp/antes.txt /tmp/despues.txt && echo "IDEMPOTENTE OK"

# 5 — LA PAGINACIÓN LLEGÓ AL FINAL. Compará contra Meta directo.
#     Es la verificación CONCLUYENTE de este task.
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)
[ -n "$T" ] || { echo "FALTA META_ADS_TOKEN en .env — agregalo antes de seguir"; exit 1; }
export V="${META_API_VERSION:-v21.0}"
export ACC=$(docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT account_id FROM ad_accounts WHERE active LIMIT 1")
# El token va en el HEADER, no en el query string (D-A3): con ads_management
# concedido, una URL de lectura filtrada es control total de la cuenta.
curl -sG "https://graph.facebook.com/$V/$ACC/ads" \
  --data-urlencode "fields=id" --data-urlencode "limit=500" \
  --data-urlencode "summary=total_count" -H "Authorization: Bearer $T" \
  | python3 -c 'import sys,json; print("Meta dice:", json.load(sys.stdin)["summary"]["total_count"])'
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT 'la base dice: '||count(*) FROM ads WHERE account_id = '$ACC';"
# TIENEN QUE COINCIDIR. Si la base tiene menos, la paginación se cortó y el
# gestor va a mostrar una jerarquía incompleta sin ningún error.

# 6 — budget_level y budgetMode se infirieron y son coherentes (§4)
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT budget_level,
          count(*)                                           AS campanias,
          count(daily_budget)                                AS con_diario,
          count(lifetime_budget)                             AS con_total
     FROM ad_campaigns GROUP BY 1;"
# esperado: las de budget_level='campaign' tienen con_diario + con_total = campanias
#           las de 'adset' tienen con_diario = 0 y con_total = 0
#
# ANOTÁ `con_total`. Cada campaña con presupuesto TOTAL es un objeto que el
# gestor muestra pero NO puede editar, y que las reglas de presupuesto tienen que
# omitir con motivo 'presupuesto_lifetime_no_soportado' (D-A10). Si ese número es
# alto, decilo: el usuario puede creer que la escalera de presupuesto le aplica a
# campañas donde no va a hacer nada.

# 6b — ninguna campaña quedó con los DOS presupuestos, y si alguna quedó, gana lifetime
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_campaigns
    WHERE daily_budget IS NOT NULL AND lifetime_budget IS NOT NULL;"
# esperado: 0. Meta usa uno u otro. Si es > 0, anotalo: no es un error tuyo, pero
# la lectura conservadora es tratarlo como lifetime (fuera de la automatización).

# 6c — las cuentas que no facturan en EUR se saltearon y se reportaron (§4)
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT account_id, currency, active FROM ad_accounts ORDER BY 1;"
# Si alguna tiene currency <> 'EUR', la salida de `npm run ads:jerarquia` tiene
# que decirlo explícitamente y NO tiene que haber filas suyas en ad_campaigns.
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_campaigns c JOIN ad_accounts a USING (account_id)
    WHERE a.currency IS DISTINCT FROM 'EUR';"
# esperado: 0

# 7 — ningún conjunto de una campaña CBO quedó con presupuesto propio (§4)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_sets s JOIN ad_campaigns c USING (campaign_id)
    WHERE c.budget_level = 'campaign' AND s.daily_budget IS NOT NULL;"
# esperado exactamente: 0

# 8 — effective_status se está guardando de verdad
grep -n "effective_status" lib/ads/meta.ts | head -5
# PRIMERO esto: que el campo se esté PIDIENDO. Es lo único concluyente.
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_sets WHERE effective_status IS NOT NULL;"
# esperado: > 0. Si es 0 y el grep encontró el campo, lo estás perdiendo al mapear.

docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT status, effective_status, count(*) FROM ad_sets GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10;"
# OBSERVACIÓN, no criterio: lo ideal es que aparezca alguna fila donde
# status <> effective_status (típicamente ACTIVE con CAMPAIGN_PAUSED), porque es
# el caso que T17 necesita para probar su badge.
#
# Pero que TODAS coincidan NO es un fallo y no bloquea: una cuenta cuyas campañas
# están todas en el mismo estado no tiene ninguna divergencia, y eso es normal.
# Con el grep de arriba en verde, anotalo para T17 y seguí. La versión anterior de
# este task lo pedía como requisito y eso convertía una cuenta sana en un bloqueo.

# 9 — el gasto que ya existía no se tocó
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*), coalesce(sum(spend_eur),0) FROM ad_spend;"
# idéntico a antes de correr este task

# 10 — no se tocó nada fuera de la fila T14 de §8 del plan
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

## 9. Cuándo parar

**Bloqueante, pará y avisá:**

- **La verificación 5 no coincide.** Una jerarquía incompleta hace que el gestor no muestre objetos que
  existen y que las reglas los ignoren. Es peor que no tener el módulo, porque parece completo.
- **La verificación 3b devuelve algo distinto de 0.** Son los invariantes de verdad: integridad
  referencial, `campaign_id` coherente y vocabulario de `status`. Un `campaign_id` desnormalizado mal
  copiado hace que el gestor baje de campaña a conjuntos y no encuentre nada.
- Alguno de los tres niveles queda en cero.
- **La verificación 6c encuentra filas de una cuenta que no factura en EUR.** Ese objeto va a recibir un
  `daily_budget` en la unidad mínima equivocada (D-A10), y el error no se ve en ningún log.
- El conteo de `ad_spend` cambió. Este task no escribe esa tabla.

> **Lo que YA NO es bloqueante**, porque no era un invariante: que `anuncios < conjuntos`. Una campaña
> puede existir sin conjuntos y un conjunto sin anuncios. La versión anterior de este task lo pedía como
> criterio de aprobación y eso convertía una cuenta perfectamente sana en un bloqueo. Es una observación:
> lo concluyente es la verificación 5.

**Anotalo en §10 del plan y seguí:**

- `huerfanos > 0` de forma consistente. Anotá cuántos y de qué nivel: puede ser normal (campañas
  archivadas) o puede ser que falte un filtro.
- **Cuántos objetos tienen presupuesto TOTAL** (verificación 6). Es el número que le dice al usuario para
  qué parte de su cuenta la escalera de presupuesto no va a hacer nada (D-A10).
- Meta devuelve un `bid_strategy` u `optimization_goal` con un valor que no está documentado. Se guarda
  como viene, es `text`.
- Todos los `effective_status` coinciden con `status` **y** verificaste que estás pidiendo el campo (el
  `grep` de la verificación 8). Es normal si la cuenta está toda en el mismo estado; anotalo para que T17
  no lo trate como un bug y sepa que no puede probar su badge con estos datos.
- Necesitás un campo de Meta que `MetaCampaign`/`MetaAdSet`/`MetaAd` de `lib/ads/tipos.ts` no tienen.
  **No modifiques ese archivo:** anotalo. T15, T16, T17, T18 y T19 lo están importando ahora mismo.
