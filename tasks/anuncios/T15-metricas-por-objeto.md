# T15 — Métricas por objeto: el cruce de gasto con ventas reales

- **Depende de:** T13 (la migración 016 y `lib/ads/tipos.ts`).
- **Bloquea:** T17 (la tabla del gestor). T16 y T18 consumen el **tipo**, no la implementación.
- **Se puede correr en paralelo con:** T14 y T16.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `lib/queries/ads.ts` y `lib/queries/ads.test.ts`. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo. El **§4 es el contrato congelado** que este task implementa, y la
**D-A7** son las definiciones de ROI, ROAS y GANANCIA: se copian, no se reinterpretan.

**`lib/queries/ads.ts` ya existe como stub cuando arrancás.** Lo dejó T13 con la firma correcta y un
cuerpo que tira, para que T16 pudiera compilar mientras vos lo implementás (§8 del plan, la única
excepción a la exclusividad de archivos). **Reemplazalo completo**, no lo edites, y borrá el comentario
`// T15 reemplaza este archivo completo.` de la primera línea.

---

## 1. Objetivo

Implementar `getMetricasAds(f: FiltrosAds)` según el §4 del plan: una fila por campaña, conjunto o
anuncio, con el gasto de Meta y la plata real de las ventas al lado, más el contador de ventas sin
atribuir.

Es la pieza sobre la que se apoyan la tabla del gestor y cada condición de cada regla. **Si estos
números están mal, el motor pausa campañas rentables.** Todo lo demás del módulo es plomería.

Este task **no toca la red, no escribe en Meta y no evalúa reglas.** Es SQL y mapeo.

## 2. Antes de escribir: leé `lib/queries/sales.ts` completo

Es obligatorio, por dos razones distintas.

**La primera: copiar la convención, no inventarla.** `sales.ts` ya decidió qué `status` de orden
contribuye a cada término del neto (qué cuenta como bruto, qué como devuelto, si las comisiones de una
orden devuelta se restan o no). Esas decisiones **tienen que ser idénticas acá**, o la sección Ventas y
la sección Anuncios van a mostrar dos netos distintos para el mismo día y el panel deja de servir.
Copiá su tratamiento de `status`, de `FILTER (WHERE ...)` y de los `COALESCE`.

**La segunda: NO copiar su `roi`.** Ese campo existe en `sales.ts` y significa otra cosa:
`resultado / gasto_total`, con `gasto_total = comisiones + costos + ads`. Acá `roi = neto / gasto_ads`
(D-A7). Los dos son válidos y miden cosas distintas; lo que no se puede es mezclarlos. Los umbrales de
las reglas del usuario (1.1 a 1.3) están en la escala de **este** módulo.

```
ingresos   = amount_eur de las órdenes aprobadas atribuidas al objeto
devuelto   = amount_eur de las refunded / chargeback
comisiones = commission_amount_eur      (ya congelada en la orden)
costos     = cost_amount_eur            (ya congelada en la orden)
gasto      = spend_eur de ad_spend para ese objeto y esos días

neto     = ingresos − devuelto − comisiones − costos
GANANCIA = neto − gasto
ROAS     = ingresos / gasto      ← sin comisiones ni costos
ROI      = neto     / gasto      ← con comisiones y costos
CPA      = gasto / ventas aprobadas
```

También leé `lib/day.ts`: la aritmética de fechas de este proyecto se hace **en SQL** con
`AT TIME ZONE`, nunca con `Date` de JS.

## 2b. Una limitación del gasto que hay que conocer antes de confiar en estos números

`getMetricasAds` lee `ad_spend`, que llena `syncAdSpend`. Ese sincronizador **no reconcilia el gasto que
Meta corrige a la baja** (P-A07 del plan), y este task no lo arregla porque `lib/ads/sync.ts` está en la
lista de los que nadie toca: es el camino por el que hoy entra el gasto de Resumen y de Ventas.

Concretamente, en `lib/ads/sync.ts`:

```ts
const conGasto = filas.filter((f) => f.spend > 0);   // :105  ← las de gasto 0 se descartan
if (dryRun || conGasto.length === 0) continue;        // :119  ← si no vino nada, no se toca nada
```

El upsert es idempotente **para las filas que Meta devuelve**, pero no borra ni pone en cero las que
dejaron de venir. Así que si Meta corrige el gasto de un anuncio-día a cero (crédito por tráfico
inválido, ajuste de facturación), **el valor viejo queda persistido para siempre**.

**Por qué no es una catástrofe y por qué igual hay que medirlo.** Intradía el gasto de Meta sólo sube, así
que el caso golpea sobre todo a los períodos `7d` y `7d_excl_today`, donde entran los ajustes posteriores
al cierre. De las seis reglas del usuario la única que mira 7 días es la de activar a las 0 horas, que
**activa** en lugar de pausar: el peor caso es reactivar algo que no correspondía.

**Lo que este task tiene que hacer: medir la magnitud, no arreglarla.** La verificación 5b tiene la
consulta. Si el número es alto, la reconciliación sube de prioridad y las reglas de 7 días esperan. Lo que
**no** hay que hacer es escribir una segunda ruta de sincronización para "arreglarlo por acá": dos
implementaciones del gasto es exactamente cómo el panel termina mostrando dos números distintos para lo
mismo.

## 3. El bug más caro del módulo: el día no es el mismo en las dos zonas

`ad_spend.day` viene en la zona de la **cuenta de Meta**. `orders.day` está congelado en la zona del
**funnel** (`America/Argentina/Buenos_Aires`) y nunca se recalcula.

**Las zonas reales de las cuentas, verificadas contra la base y no supuestas:**

| Cuenta | Zona | ¿Corrimiento contra `orders.day`? |
|---|---|---|
| `act_2501344510302910` | `Europe/Lisbon` | **sí**, 4 o 5 horas según la época del año |
| `act_2120381458824082` | `America/Argentina/Buenos_Aires` | no: misma zona que los funnels |

Así que el corrimiento aplica a **una** de las dos cuentas, no a las dos. Eso no lo hace menos importante:
la query tiene que agrupar por la zona de la cuenta igual, porque es la única forma de que las dos den bien
con el mismo código. Lo que sí implica es que **las dos cuentas cortan el día en momentos distintos**, así
que compararlas lado a lado en el gestor no es comparar lo mismo, y por eso `rango.timezone` se muestra.

**Una venta de las 21:30 de Buenos Aires es del día siguiente en Lisboa.** Verificado en
`_verificacion-016.sql` §6:

```
2026-08-12 21:30 -03  →  día del funnel: 2026-08-12
                      →  día de la cuenta: 2026-08-13
```

Agrupar por `orders.day` y cruzarlo contra `ad_spend.day` mete esas ventas en el día equivocado, y el
ROI del día se calcula contra el gasto de otro día. Con reglas que pausan por ROI, eso es plata.

**La regla, sin excepciones:** las ventas se agrupan por
`(o.purchased_at AT TIME ZONE cuenta.timezone)::date`. **Nunca** por `orders.day`.

Y el corolario para el filtrado: no se puede filtrar `orders` por el día de la cuenta antes de saber
cuál es la cuenta. Se filtra primero por `purchased_at` con **un margen de 2 días** a cada lado del
rango, y después se recorta con precisión una vez resuelta la zona. Sin el margen se pierden las ventas
del borde; sin el pre-filtro, cada tick del motor hace un seq scan de `orders`.

```sql
WHERE o.purchased_at >= ($desde::date - 2)::timestamptz
  AND o.purchased_at <  ($hasta::date + 2)::timestamptz
```

Si `ad_accounts.timezone` está en `NULL` (P-A03), **no asumas UTC en silencio**: caé a un default
explícito, dejalo en una constante con nombre, y devolvelo en `rango.timezone` para que la UI lo pueda
mostrar. Un día corrido sin aviso es exactamente el bug que este §existe para evitar.

### Y una llamada = UNA zona horaria. Si se mezclan, se TIRA.

`accountIds: []` significa "todas las cuentas activas", pero el contrato devuelve **un solo**
`rango.timezone`, y `debeCorrer` de T16 evalúa la ventana horaria con **una sola** hora local. Con dos
cuentas en zonas distintas, "hoy" y el cierre del día son distintos para cada una: una regla global usaría
el rango equivocado para parte de las cuentas, y alrededor de medianoche o de un cambio de horario correría
dos veces o ninguna.

**Y las dos cuentas del usuario NO comparten zona** (la tabla de arriba), así que esto **no es un caso
teórico: es el caso por defecto**. Toda regla con `accountIds: []` —las seis del seed nacen así— cae acá.
El supuesto tiene que ser **ruidoso**, no implícito:

```ts
// Después de resolver las cuentas alcanzadas:
const zonas = new Set(cuentas.map((c) => c.timezone ?? TZ_DEFAULT));
if (zonas.size > 1) {
  throw new Error(
    `zonas horarias mezcladas: ${cuentas.map((c) => `${c.accountId}=${c.timezone}`).join(', ')}. ` +
    'Esta versión no soporta una regla sobre cuentas en zonas distintas (P-A09).',
  );
}
```

**Tirar y no elegir la primera.** Elegir la primera produce números mal calculados que se ven bien, y una
regla de ROI decidiendo contra el gasto de otro día es plata. T16 captura este error y omite la regla con
`motivo: 'zonas_horarias_mezcladas'`, así que queda en el historial en castellano.

Soportarlo de verdad es expandir la regla por cuenta y agrupar por zona: cambio de schema y de contrato,
anotado en P-A09, **que ya no es hipotético**. Mientras eso no exista, cada regla lleva una cuenta asignada
y la misma lógica sobre las dos cuentas son dos reglas (con nombres distintos: `ad_rules_name_unico` es un
índice único sobre el nombre).

## 4. La atribución: cascada por el id más profundo disponible

Los funnels mandan `{{campaign.name}}|{{campaign.id}}` en `utm_campaign`, el conjunto en `utm_medium` y
el anuncio en `utm_content`. La extracción del id, **verificada con y sin espacios alrededor del pipe**
(`_verificacion-016.sql` §5):

```sql
CASE
  WHEN utm ~ '\|\s*[0-9]{6,}\s*$' THEN btrim(substring(utm from '[0-9]+\s*$'))
  WHEN utm ~ '^\s*[0-9]{9,}\s*$'  THEN btrim(utm)
  ELSE NULL
END
```

Los guardias de longitud no son decorativos: sin ellos, una campaña llamada "2026" se toma como un id.
Y la tolerancia a espacios tampoco: un nombre que termina en `" | 12021..."` se pierde entero, **y se
pierde en silencio** (la venta no desaparece, solo deja de estar atribuida).

**La cascada.** Se resuelve el id más profundo que matchee, y desde ahí se sube por la jerarquía, que
es la fuente autoritativa:

```
utm_content  matchea ads.ad_id           →  se toman adset_id y campaign_id DE LA TABLA ads
utm_medium   matchea ad_sets.adset_id    →  se toma campaign_id DE LA TABLA ad_sets, ad_id = ''
utm_campaign matchea ad_campaigns        →  solo campaña
nada matchea                             →  va al contador de sinAtribuir
```

**Se sube por la jerarquía y no por los otros UTMs** porque el `utm_medium` de una orden puede estar
mal (un enlace armado a mano, un creativo duplicado con los UTMs viejos), y la relación
anuncio → conjunto → campaña de la tabla es la que Meta dice. Si se confiara en los tres UTMs por
separado, una orden podría contarse en la campaña A y en el conjunto de la campaña B.

**Consecuencia esperada, no un bug:** a nivel campaña hay más ventas atribuidas que a nivel anuncio,
porque las órdenes que solo traen el id de campaña suman ahí. Por eso `sinAtribuir` **se calcula para
el nivel pedido**, no una sola vez, y por eso hay que mostrarlo (D-A8): una venta que no se atribuye no
se pierde, pero tiene que ser visible.

## 5. La forma de la query

Una sola query con CTEs, no cinco queries y un merge en TypeScript. El orden importa:

```sql
WITH cuenta AS (          -- cuentas activas + su zona + su funnel
  ...  WHERE active AND platform = 'meta'
       AND ($1::text[] IS NULL OR cardinality($1) = 0 OR account_id = ANY($1))
),
rango AS (                -- el desde/hasta resuelto EN LA ZONA DE CADA CUENTA
  ...  (now() AT TIME ZONE c.tz)::date  como "hoy" de esa cuenta
),
objetos AS (              -- la jerarquía, filtrada por nivel, estado, nombre y vigencia
  ...
),
gasto AS (                -- ad_spend agregado al nivel pedido
  ...  GROUP BY la clave del nivel
),
ordenes AS (              -- orders con los ids extraídos y el pre-filtro de ±2 días
  ...
),
atribuidas AS (           -- la cascada del §4 + el día en la zona de la cuenta
  ...
),
ventas AS (               -- agregados por objeto, con FILTER por status
  ...
)
SELECT ...
  FROM objetos o
  LEFT JOIN gasto  g USING (...)
  LEFT JOIN ventas v USING (...)
  LEFT JOIN ultima_accion u USING (...)
```

Cinco cosas que definen si esto queda bien o mal:

**1. `objetos` va primero y los `JOIN` son `LEFT`.** La lista sale de la jerarquía, no de `ad_spend`.
Un conjunto pausado que no gastó hoy tiene que aparecer **con ceros**, porque es exactamente el que se
quiere reactivar. Si se parte de `ad_spend`, desaparece de la pantalla.

**2. Pero un objeto con gasto que todavía no está en la jerarquía también aparece.** T14 y este task
pueden estar desfasados (el sync de jerarquía corre cada tanto, el gasto entra en el render). Sumá un
`UNION` de los ids que están en `gasto` y no en `objetos`, con el nombre desnormalizado que trae
`ad_spend.campaign_name`/`adset_name`/`ad_name` y el estado en `NULL`. Sin esto, plata gastada que no
se ve.

**3. La vigencia se filtra igual que en T14 §5.** Pegá el mismo predicado:

```sql
synced_at >= (SELECT max(c2.synced_at) - interval '10 minutes'
                FROM ad_campaigns c2 WHERE c2.account_id = <tabla>.account_id)
```

Un objeto que Meta ya no devuelve no se lista. T14 lo exporta como `SQL_VIGENTE`; si ya está
disponible, importalo en lugar de duplicarlo.

**4. Los parámetros van siempre como `$1, $2`.** Nunca concatenados. Y ojo con el patrón laxo:
`($1::text[] IS NULL OR account_id = ANY($1))` con un array **vacío** no devuelve nada, así que hay que
chequear `cardinality($1) = 0` aparte. Es el mismo tipo de trampa que el `funnel_id` del plan original,
donde `NULL` significaba "todos" en un lado y "sin atribuir" en el otro.

**5. Los `numeric` de `pg` llegan como string y los `bigint` también.** Se convierten con `Number()`
una vez, en el mapeo, con aliases en camelCase dentro del SQL (`AS "spendEur"`), igual que el resto de
`lib/queries/`.

**6. La respuesta viene ACOTADA, con `limit` y cursor, desde la primera versión.** `FiltrosAds` lleva
`limit` (default 500, máximo 1000) y `after`, y el resultado lleva `hayMas`.

No es una optimización prematura: `GET /api/data/ads` devolvía el conjunto entero, y ese conjunto crece
con la cuenta del usuario sin ningún techo. Con un tick por minuto y una tabla de anuncios que sólo crece,
"hoy hay pocos anuncios" no es una propiedad del sistema, es una circunstancia. Y un `OFFSET` grande sobre
una tabla con inserciones constantes además **saltea filas**, así que el cursor es por `objectId` estable y
no por offset:

```sql
ORDER BY <la clave del nivel>
WHERE ($N::text IS NULL OR <la clave del nivel> > $N)
LIMIT $M + 1        -- se pide uno más para saber si hay página siguiente
```

`hayMas` sale de si llegaron `limit + 1` filas; se devuelven `limit` y se descarta la extra.

**7. `budgetMode` se devuelve, y sale de la jerarquía, no de una inferencia.** T14 ya distingue `daily` de
`lifetime` al guardar (su §4). Este task lo propaga tal cual:

```
daily_budget con valor     → budgetMode = 'daily'      ← editable y automatizable
lifetime_budget con valor  → budgetMode = 'lifetime'   ← se muestra, no se toca
los dos en null            → budgetMode = null
```

Sin este campo, T17 muestra editable un presupuesto que Meta rechaza y T16 le manda un `daily_budget` a un
objeto con presupuesto total en cada corrida (D-A10).

## 6. Los cuatro cálculos que se hacen en TypeScript, no en SQL

Todo lo demás es SQL. Estos cuatro salen del mapeo porque tienen que devolver `null` y en SQL eso se
enreda con los `COALESCE`:

```ts
const roas   = spendEur > 0 ? revenueEur / spendEur : null;
const roi    = spendEur > 0 ? netEur     / spendEur : null;
const cpaEur = sales    > 0 ? spendEur   / sales    : null;
const ctr    = impressions > 0 ? clicks / impressions : null;
```

**`null` y no `0`. Es la regla más importante del task.** Un conjunto con €0 de gasto y una venta no
tiene ROI infinito ni ROI cero: **no tiene ROI**. Si se devuelve `0`, la condición `ROI < 1.1` de la
regla "Apagar - Gasto +$10 ROI -1.10" se cumple, y el motor pausa un conjunto que todavía no gastó nada.
Es el falso positivo más caro del sistema y se previene acá, en cuatro líneas.

`profitEur` y `netEur` sí pueden ser `0` legítimamente: son sumas, no cocientes.

## 7. Tests

`lib/queries/ads.test.ts`. Dos grupos.

**Puras, siempre corren.** Extraé el mapeo a una función exportada (`filaDesdeRow` o similar) y probá:

1. `spendEur = 0` con ventas → `roas`, `roi` y `cpaEur` en `null`. **No en 0, no en Infinity.**
2. `sales = 0` con gasto → `cpaEur` en `null`, y `roi` calculado igual (el denominador del ROI es el
   gasto, no las ventas).
3. Los `numeric` que llegan como string se convierten: `{ spend_eur: '44.37' }` → `44.37`, no `'44.37'`.
4. `neto` y `GANANCIA` con números a mano, comparados contra la fórmula de D-A7 escrita aparte en el
   test. Que el test tenga la fórmula duplicada es a propósito: si alguien cambia la implementación, el
   test dice qué contrato se rompió.
5. La extracción del id desde el UTM, con los 6 casos de `_verificacion-016.sql` §5, incluido el que
   tiene espacios y el de la campaña llamada "2026".

**Con base, se saltan sin `DATABASE_URL`** (`it.skip`, como `lib/day.test.ts`):

6. El corrimiento de día entre zonas: insertá una orden a las 21:30 de Buenos Aires y verificá que cae
   en el día siguiente cuando se agrupa por Lisboa. Es la prueba de que §3 está implementado.
7. Un objeto sin gasto aparece con ceros (§5 punto 1).

**No borres un test para que pase el build.** Si falla, es información.

## 8. Verificación

Nada de esto es opcional.

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — devuelve filas para los tres niveles
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    for (const level of ['campaign','adset','ad']) {
      const r = await m.getMetricasAds({ level, period: 'today' });
      console.log(level, '→ filas:', r.filas.length,
                  '· sinAtribuir:', r.sinAtribuir.sales,
                  '· tz:', r.rango.timezone);
    }
  });
"
# esperado: filas > 0 en los tres, y la tz tiene que ser la de la cuenta
# (Europe/Lisbon), NO UTC ni America/Argentina/Buenos_Aires

# 3 — EL NÚMERO QUE DECIDE: el gasto de la query == el gasto de la base
#     Sumar el spendEur de todas las filas de nivel campaña tiene que dar
#     exactamente el gasto del día de esas cuentas.
$PSQL -tAc "
  SELECT round(sum(spend_eur), 2) FROM ad_spend
   WHERE day = (now() AT TIME ZONE (SELECT coalesce(timezone,'Europe/Lisbon')
                                      FROM ad_accounts WHERE active LIMIT 1))::date;"
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    const r = await m.getMetricasAds({ level: 'campaign', period: 'today' });
    console.log('la query dice:', r.filas.reduce((a,f) => a + f.spendEur, 0).toFixed(2));
  });
"
# TIENEN QUE COINCIDIR al céntimo. Si no, o se duplicó una fila en un JOIN
# (lo más probable) o el rango de días se resolvió en otra zona.

# 4 — el ROI a mano contra el ROI de la query, para UNA campaña
#     Elegí una campaña con gasto y con ventas y calculá los dos lados.
$PSQL -c "
  WITH cta AS (SELECT account_id, coalesce(timezone,'Europe/Lisbon') tz
                 FROM ad_accounts WHERE active LIMIT 1),
  hoy AS (SELECT (now() AT TIME ZONE tz)::date d, tz, account_id FROM cta),
  g AS (SELECT s.campaign_id, sum(s.spend_eur) gasto
          FROM ad_spend s, hoy WHERE s.account_id = hoy.account_id AND s.day = hoy.d
         GROUP BY 1),
  v AS (SELECT btrim(substring(o.utm_campaign from '[0-9]+\s*\$')) cid,
               sum(o.amount_eur) FILTER (WHERE o.status='approved') ingresos,
               sum(coalesce(o.commission_amount_eur,0) + coalesce(o.cost_amount_eur,0))
                 FILTER (WHERE o.status='approved') restar,
               count(*) FILTER (WHERE o.status='approved') ventas
          FROM orders o, hoy
         WHERE o.utm_campaign ~ '\|\s*[0-9]{6,}\s*\$'
           AND (o.purchased_at AT TIME ZONE hoy.tz)::date = hoy.d
         GROUP BY 1)
  SELECT g.campaign_id, g.gasto, v.ingresos, v.ventas,
         round((v.ingresos - v.restar) / nullif(g.gasto,0), 4) AS roi_a_mano,
         round(v.ingresos / nullif(g.gasto,0), 4)              AS roas_a_mano
    FROM g LEFT JOIN v ON v.cid = g.campaign_id
   WHERE v.ventas > 0 ORDER BY g.gasto DESC LIMIT 3;"
# Comparalo con el roi/roas que devuelve getMetricasAds para esas campañas.
# Si no coinciden, NO ajustes la query hasta que dé: buscá la causa. Las dos
# causas reales son la zona horaria (§3) y las devoluciones.

# 5 — el corrimiento de día está implementado
$PSQL -tAc "
  SELECT count(*) FROM orders
   WHERE (purchased_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      <> (purchased_at AT TIME ZONE 'Europe/Lisbon')::date;"
# Este número es cuántas órdenes históricas caen en un día distinto según la
# zona. Si es > 0 (va a serlo), agrupar por orders.day estaba mal. Anotalo:
# es la magnitud del bug que este task evita.

# 5b — MEDÍ EL GASTO OBSOLETO (§2b y P-A07). No lo arreglás acá: lo cuantificás.
#      syncAdSpend filtra spend > 0 y nunca pone en cero una fila que dejó de
#      venir, así que un gasto corregido a la baja por Meta queda persistido.
#      Estas dos consultas dicen si eso es un problema real en esta cuenta.
$PSQL -c "
  -- Filas cuyo synced_at quedó viejo mientras OTRAS del mismo día se
  -- refrescaron: candidatas a gasto fantasma (Meta dejó de reportarlas).
  WITH ult AS (
    SELECT account_id, day, max(synced_at) AS ultimo
      FROM ad_spend WHERE day > current_date - 10 GROUP BY 1, 2
  )
  SELECT s.day,
         count(*)                                                    AS filas,
         count(*) FILTER (WHERE s.synced_at < u.ultimo - interval '1 hour') AS quedaron_atras,
         round(sum(s.spend_eur) FILTER (WHERE s.synced_at < u.ultimo - interval '1 hour'), 2)
           AS eur_sospechoso
    FROM ad_spend s JOIN ult u USING (account_id, day)
   GROUP BY 1 ORDER BY 1 DESC;"
# `quedaron_atras` > 0 significa que ese día tiene filas que Meta ya no devuelve
# pero siguen contando. ANOTÁ el eur_sospechoso del período de 7 días: es
# exactamente la plata que una regla podría estar viendo y que ya no existe.
#
# Si es un porcentaje relevante del gasto de 7 días, decilo fuerte: las reglas con
# period='7d' o '7d_excl_today' no son confiables hasta que se reconcilie, y en el
# seed hay una (la de activar a las 0 horas).
#
# Si es 0 o despreciable, también anotalo: es la evidencia de que P-A07 puede
# esperar, y esa evidencia hoy no existe.

# 6 — un objeto pausado sin gasto aparece con ceros (§5 punto 1)
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    const r = await m.getMetricasAds({ level: 'adset', period: 'today', status: 'paused' });
    const sinGasto = r.filas.filter(f => f.spendEur === 0);
    console.log('conjuntos pausados listados:', r.filas.length, '· con gasto 0:', sinGasto.length);
    console.log('roi de esos:', [...new Set(sinGasto.map(f => f.roi))]);
  });
"
# esperado: se listan, y el roi de los que tienen gasto 0 es [null].
# Si aparece 0 en esa lista, el §6 no se cumplió y el motor va a pausar de más.

# 7 — sin ninguna condición no se rompe con arrays vacíos (§5 punto 4)
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    const r = await m.getMetricasAds({ level: 'campaign', period: 'today', accountIds: [] });
    console.log('con accountIds vacío →', r.filas.length, 'filas (tiene que ser > 0)');
  });
"

# 7b — el límite de filas y el cursor funcionan (§5 punto 6)
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    const p1 = await m.getMetricasAds({ level: 'ad', period: 'today', limit: 2 });
    console.log('página 1:', p1.filas.map(f => f.objectId), 'hayMas:', p1.hayMas);
    if (p1.hayMas) {
      const p2 = await m.getMetricasAds({ level: 'ad', period: 'today', limit: 2,
                                          after: p1.filas[p1.filas.length - 1].objectId });
      console.log('página 2:', p2.filas.map(f => f.objectId));
      const repetidos = p2.filas.filter(f => p1.filas.some(x => x.objectId === f.objectId));
      console.log('repetidos entre páginas (tiene que ser 0):', repetidos.length);
    }
  });
"
# esperado: exactamente 2 filas por página, hayMas correcto, y CERO repetidos.
# Un cursor que repite o saltea filas hace que el gestor muestre un objeto dos
# veces o ninguna, y nadie lo nota hasta que falta justo el que se busca.

# 7c — budgetMode se propaga desde la jerarquía (§5 punto 7)
npx tsx -e "
  import('./lib/queries/ads').then(async (m) => {
    const r = await m.getMetricasAds({ level: 'adset', period: 'today', status: 'any' });
    const porModo = r.filas.reduce((a, f) => ((a[String(f.budgetMode)] = (a[String(f.budgetMode)] ?? 0) + 1), a), {});
    console.log('budgetMode:', porModo);
    console.log('lifetime con presupuesto editable (tiene que ser 0):',
      r.filas.filter(f => f.budgetMode === 'lifetime' && f.dailyBudgetEur !== null).length);
  });
"
# Un objeto con budgetMode 'lifetime' NO puede traer dailyBudgetEur: si lo trae,
# T17 lo va a mostrar editable y T16 le va a mandar un daily_budget que Meta
# rechaza en cada corrida (D-A10).

# 7d — MEDÍ EL PLAN DE LA QUERY. Es lo que decide si hacen falta índices (D-A17).
#      La 016 crea SOLO orders_purchased_at_idx: los tres B-tree sobre las
#      columnas UTM se sacaron porque un B-tree sobre el valor completo no puede
#      responder ni `utm_campaign ~ '...'` ni el substring que extrae el id.
$PSQL -c "EXPLAIN (ANALYZE, BUFFERS) <pegá acá la query que generó getMetricasAds>"
# Qué mirar:
#   · si el nodo sobre `orders` usa orders_purchased_at_idx → el pre-filtro de
#     ±2 días está funcionando y no hace falta nada más
#   · si hace Seq Scan de orders con muchas filas descartadas → el pre-filtro no
#     se está aplicando (revisá que el WHERE sea sobre purchased_at y no sobre una
#     expresión que impida usar el índice)
#   · si el filtro por UTM es el que descarta el 99% y cuesta → ahí sí hace falta
#     un índice de EXPRESIÓN sobre el id extraído, con la MISMA expresión de §4.
#     Va en una 017 medida, NO en la 016, y el comentario del DDL lo tiene escrito.
# ANOTÁ el tiempo total y el plan elegido. Sin este número, "agregar un índice" es
# una corazonada.

# 8 — no se tocó nada de lo existente
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

- **La verificación 3 no coincide al céntimo.** Casi siempre es un `JOIN` que duplica filas (un objeto
  con dos filas de `ad_spend` del mismo día en distinto nivel, o un `LEFT JOIN` a ventas que multiplica
  el gasto). Un gasto duplicado hace que el ROI se vea a la mitad y las reglas pausen todo.
- **La verificación 4 no coincide.** Si el ROI de la query no es el ROI calculado a mano, el motor va a
  decidir con un número inventado. No ajustes hasta que dé: encontrá la causa.
- **La verificación 6 devuelve `0` en lugar de `null`.** Es el falso positivo del §6 y es plata.
- `rango.timezone` devuelve UTC. Significa que `ad_accounts.timezone` está vacío y el §3 se resolvió
  asumiendo en silencio (P-A03).

**Anotalo en §10 del plan y seguí:**

- El número de la verificación 5 (cuántas órdenes caen en días distintos según la zona). Anotalo: es la
  magnitud real del problema y sirve para explicar por qué los números de Anuncios no van a coincidir
  exactamente con los de Ventas.
- **El `eur_sospechoso` de la verificación 5b, sí o sí.** Es la respuesta empírica a P-A07 y hoy no
  existe. Si es un porcentaje relevante del gasto de 7 días, decilo fuerte: las reglas con `period='7d'`
  o `'7d_excl_today'` no son confiables hasta reconciliar, y el seed tiene una.
- **El plan y el tiempo del `EXPLAIN` de la verificación 7d.** Es lo que decide si hace falta un índice de
  expresión en una 017. Sin ese número, agregar un índice es una corazonada, y agregarlo sobre `orders`
  cuesta un lock y mantenimiento en cada pedido nuevo.
- Cuántos objetos tienen `budgetMode = 'lifetime'`. Son los que la escalera de presupuesto no va a tocar
  (D-A10), y el usuario tiene que saber para qué parte de su cuenta las reglas no hacen nada.
- `sinAtribuir` es alto (más del 20% de las ventas del día). Puede ser normal (tráfico orgánico,
  directo) o puede ser que los UTMs de un funnel estén mal armados. Anotá el porcentaje por nivel.
- `sales.ts` trata un `status` de una forma que te parece incorrecta. **No la cambies acá ni allá:**
  anotala. Que las dos secciones coincidan vale más que tener razón, y `sales.ts` no es de este task.
- Necesitás una métrica que `MetricasObjeto` no tiene. **No modifiques `lib/ads/tipos.ts`:** T16, T17,
  T18 y T19 lo están importando ahora mismo. Anotalo.
