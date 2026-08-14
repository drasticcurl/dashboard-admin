# T13 — Fundación de anuncios: migración, contratos y escritura a Meta

- **Depende de:** nada (el panel ya está construido y corriendo).
- **Bloquea:** T14, T15, T16, T17, T18 y T19. Ninguna arranca antes de que esta termine y compile.
- **Corre sola.** No paralelizar con nada.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** los de la fila T13 de §8 del plan. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo antes de escribir una línea. El §3 apunta al schema canónico
(`_schema-016.sql`), que se copia tal cual, y los §4, §5 y §6 son los contratos congelados que este
task tiene que dejar escritos porque **seis tasks los van a importar sin poder modificarlos**.

---

## 1. Objetivo

Dejar el proyecto en un estado en el que:

- se sabe **con certeza** que el `META_ADS_TOKEN` puede escribir en las cuentas publicitarias,
- `npm run db:migrate` aplicó la 016 y es idempotente,
- `lib/ads/tipos.ts` existe con los tres contratos completos,
- `lib/ads/meta.ts` sabe leer la jerarquía y escribir estado y presupuesto,
- `npx tsc --noEmit` y `npm run build` pasan.

Este task **no escribe ninguna pantalla, ninguna query de métricas y ninguna regla.**

## 2. Lo primero, antes de todo lo demás: probar que el token puede escribir

El usuario cree que le dio `ads_management` al `META_ADS_TOKEN`, pero no está verificado (P-A01 del
plan). Leer gasto necesita `ads_read` y escribir necesita `ads_management`: son permisos distintos, y
además el usuario del sistema tiene que tener la cuenta **asignada con rol de administrador**, no de
analista. El panel hoy solo demostró el primero.

**Hacé esta verificación antes de escribir código.** Si falla, no sirve nada de lo que sigue.

### Paso 0: el token tiene que estar en el `.env`, y no está

**Verificado: el `.env` local NO contiene `META_ADS_TOKEN`.** Sus claves son `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `DB_PORT`, `DATABASE_URL`, `DASHBOARD_TZ` y
`SHOPIFY_WEBHOOK_SECRETS`. El token vive sólo en el `.env.production` de la VPS, y nunca se documentó.

Así que el idiom que usaban las verificaciones de este módulo devolvía **string vacío**, `$T` quedaba
vacío, el `curl` salía con `access_token=` y Meta contestaba algo sobre credenciales inválidas. Se
pierden treinta minutos buscando un problema de permisos que no existe. Agregá el token al `.env` local
a mano y **leelo fallando fuerte**:

```bash
cd ~/Desktop/funnel/dashboard-admin
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)
[ -n "$T" ] || { echo "FALTA META_ADS_TOKEN en .env — agregalo antes de seguir"; exit 1; }
export V="${META_API_VERSION:-v21.0}"     # D-A16b: la versión es configurable
```

Ese guard de dos líneas va en **todas** las verificaciones de este módulo que hablen con Meta. Un
`curl` que falla por una variable vacía miente sobre la causa.

### Paso 1: qué permisos declara el token

```bash
# El token que AUTENTICA va en el header (D-A3). `input_token` es el token que se
# está inspeccionando y sí es un parámetro de la query: es el dato, no la credencial.
curl -sG "https://graph.facebook.com/$V/debug_token" \
  --data-urlencode "input_token=$T" -H "Authorization: Bearer $T" | python3 -m json.tool
# En `data.scopes` tiene que aparecer ads_management. Si solo está ads_read, PARÁ.
# Si debug_token devuelve error (pasa con algunos tokens de usuario del sistema),
# no concluyas nada: seguí al paso 2, que es el que decide.
```

### Paso 2: LA PRUEBA QUE DECIDE, sobre un objeto que vos autorizaste

No existe un endpoint de "probar permisos de escritura" en la Marketing API: **el permiso se demuestra
escribiendo.** Poner en `PAUSED` una campaña que ya está pausada es la única escritura sin efecto: el
estado antes y después es el mismo, no reinicia ninguna fase de aprendizaje y no mueve un euro.

**Pero el objeto lo elegís vos, explícitamente, y no el script.** La versión anterior de este task tomaba
`data[0]` de `/me/adaccounts` y la primera campaña con `effective_status=["PAUSED"]`, y le hacía un POST.
Eso es una prueba de instalación que escribe sobre un objeto real de producción elegido por orden de
listado. Que la escritura sea un no-op no vuelve segura la **selección**: "pausada" no significa
descartable, y el día que el filtro traiga otra cosa (una campaña en `IN_PROCESS`, un cambio de
comportamiento del filtro entre versiones de la API) el POST cae sobre lo que sea que vino primero.

```bash
# Elegí vos la campaña. Miralo en el administrador de anuncios, confirmá que es
# descartable, y ponela acá. Si no querés tocar nada, creá una campaña vacía y
# pausada a propósito para esto: es lo más barato del módulo.
export ADS_TEST_ACCOUNT=act_XXXXXXXXX
export ADS_TEST_OBJECT_ID=120210000000000

# Confirmá que es la que creés que es, y que está pausada, ANTES de escribirle.
curl -sG "https://graph.facebook.com/$V/$ADS_TEST_OBJECT_ID" \
  --data-urlencode "fields=id,name,status,effective_status,daily_budget" \
  -H "Authorization: Bearer $T" | python3 -m json.tool
# Leé el nombre. Si no es la campaña que elegiste, PARÁ.
# Si status no es PAUSED, PARÁ: el no-op sólo es no-op sobre algo ya pausado.

# Y ahora la escritura no-op.
curl -s -X POST "https://graph.facebook.com/$V/$ADS_TEST_OBJECT_ID" \
  -H "Authorization: Bearer $T" -d "status=PAUSED"
# esperado exactamente: {"success":true}
```

**El token va en el header también en los GET** (D-A3). No es cosmética: en cuanto el token tiene
`ads_management`, una URL de lectura filtrada en un log es control total de la cuenta.

Resultados posibles y qué hacer:

| Respuesta | Significa | Qué hacer |
|---|---|---|
| `{"success":true}` | el token escribe | seguí con el task |
| error `code: 200`, "Missing Permissions" | falta `ads_management` o el rol en la cuenta | **PARÁ.** Anotá en P-A01 y avisá |
| error `code: 190` | token vencido o revocado | **PARÁ.** Anotá en P-A01 y avisá |
| `$ADS_TEST_OBJECT_ID` sin definir | no elegiste un objeto de prueba | **elegilo**. No lo autoselecciones |

Si el token escribe, dejá anotado **en la salida del propio `npm run ads:token`** qué cuenta y qué objeto
se usó. Es el dato que se va a querer al volver a esto en tres meses.

**No lo anotes en el `README`:** ese archivo no está en la fila de ownership de T13 (§8 del plan) y
ninguna task de este módulo lo edita. El lugar para la nota operativa larga es
`docs/runbook-anuncios.md`, que es de T18.

## 3. `db/migrations/016_ads_gestion.sql`

**Copiá `tasks/anuncios/_schema-016.sql` tal cual.** Ya se ejecutó contra un PostgreSQL 16 con las
migraciones 001-015 aplicadas: corre limpio, es idempotente y sus comentarios son el contrato que
cinco tasks van a asumir. No lo reordenes, no le agregues columnas y no le saques CHECK.

Crea: `ad_campaigns`, `ad_sets`, `ads`, `ad_rules`, `ad_rule_conditions`, `ad_rule_runs`,
`ad_actions`, **1** índice sobre `orders`, **14** filas en `settings` y **el seed de las seis reglas que
el usuario ya tenía en Utmify**.

> Los números cambiaron con la revisión técnica: **un** índice sobre `orders` y no cuatro (los tres de UTM
> no servían para la consulta de T15, ver más abajo), y **14** filas de `settings` y no diez (se agregaron
> los dos topes monetarios de D-A9c y dos contadores del backoff de D-A14).

**El seed de reglas (§6 del archivo) no es opcional ni decorativo.** Son las reglas reales del usuario,
traducidas 1:1 de su export (`_reglas-utmify.csv`, en esta carpeta), y son las que T16 va a usar para sus
tests de punta a punta. Nacen **apagadas y en modo sombra**, como cualquier regla: el seed carga la
configuración, no la enciende.

Tres traducciones que el SQL ya resolvió y que **no hay que "arreglar"**:

- **Los montos están en EUR, no en céntimos.** Utmify guarda `spend: 1000` para €10,00. Si alguien
  "corrige" eso copiando los céntimos, la regla «apagar si el gasto pasa de €4» se convierte en «si pasa
  de €400» y no se dispara nunca.
- **El porcentaje es `250`, que significa un FACTOR de ×2,5** (D-A9). Utmify guarda `2.5` y muestra
  "250%". No es `+250%` (×3,5): la aritmética de los tres techos del usuario lo prueba al céntimo
  (`actionLimitCentsInfo: 7500` = €75,00, y su condición es `budget < 3000` = €30,00; €30 × 2,5 = €75
  exacto, mientras que €30 × 3,5 = €105 y el techo cortaría en todas las corridas).

  Si encontrás algún archivo de esta carpeta que diga que 250% sobre €10,00 son €35,00, **está mal y hay
  que corregirlo, no seguirlo**. Era una contradicción real que atravesaba cuatro archivos y está resuelta
  a favor del factor: el export del usuario es la evidencia, no una interpretación.
- **Una condición se cambió:** el export trae `approvedSales LessThan 0`, que con ventas enteras no se
  puede cumplir nunca. Se cargó como `sales = 0`. Está anotado en P-A05 y el usuario tiene que
  confirmarlo.

Tres cosas para tener en cuenta al aplicarla:

**La migración corre sobre producción viva** (D-A17). Es aditiva: ni un `DROP`, ni un `ALTER` que
reescriba una tabla. El único `CREATE INDEX` cae sobre `orders`, con `CREATE INDEX` normal y no
`CONCURRENTLY` porque el runner envuelve cada archivo en una transacción y `CONCURRENTLY` no puede correr
adentro de una.

### El preflight del lock sobre `orders`. No es opcional y no está medido.

La versión anterior de este task afirmaba que `orders` "tiene miles de filas, así que el lock dura
milisegundos". **Eso era un supuesto, no una medición**: nadie consultó producción, y en la base local
hay dos filas, que no dice nada. `CREATE INDEX` toma un `ShareLock` que **bloquea los INSERT de pedidos
mientras dura**, así que el número importa.

Corré esto **en la VPS, contra la base de producción**, antes de migrar:

```bash
# 1 — cuántas filas y cuánto pesa
sudo -u postgres psql -d panel -c "
  SELECT count(*) AS filas,
         pg_size_pretty(pg_total_relation_size('orders')) AS tamano,
         pg_size_pretty(pg_relation_size('orders'))       AS solo_tabla;"

# 2 — cuántos pedidos entran por minuto en el pico (para saber a quién bloqueás)
sudo -u postgres psql -d panel -c "
  SELECT date_trunc('minute', created_at) AS minuto, count(*)
    FROM orders WHERE created_at > now() - interval '7 days'
   GROUP BY 1 ORDER BY 2 DESC LIMIT 5;"

# 3 — que no haya nada bloqueando ya
sudo -u postgres psql -d panel -c "
  SELECT pid, state, wait_event_type, left(query, 60)
    FROM pg_stat_activity WHERE datname = 'panel' AND state <> 'idle';"
```

Y decidí con el número en la mano:

| Filas de `orders` | Qué hacer |
|---|---|
| < ~500 mil | migrar normal. El lock es de segundos como mucho |
| más, o hay tráfico en el pico | crear el índice **a mano con `CONCURRENTLY` antes de migrar**; la 016 lo encuentra hecho por el `IF NOT EXISTS` y no toma lock |

En los dos casos, **poné un `lock_timeout` para que la migración falle rápido en lugar de colgar los
pedidos** mientras espera un lock que no consigue:

```bash
DATABASE_URL="$DB_URL" PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' npm run db:migrate
```

Un timeout que aborta la migración es un problema de cinco minutos. Una migración esperando un lock con
los pedidos encolados detrás es un problema de facturación.

**Y la variante `CONCURRENTLY`, si hace falta:**

```bash
sudo -u postgres psql -d panel -c \
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_purchased_at_idx ON orders (purchased_at DESC);"
# Después verificá que quedó VÁLIDO: un CONCURRENTLY que falla deja el índice inválido
# y sigue costando en cada INSERT sin servir para ninguna consulta.
sudo -u postgres psql -d panel -tAc \
  "SELECT indexrelid::regclass, indisvalid FROM pg_index
    WHERE indexrelid = 'orders_purchased_at_idx'::regclass;"
# esperado: orders_purchased_at_idx | t     ← si dice f, borralo y volvé a crearlo
```

**Un índice menos de lo que decía la versión anterior.** Los tres B-tree sobre `utm_campaign`,
`utm_medium` y `utm_content` salieron del DDL (D-A17): la consulta de T15 no busca
`utm_campaign = 'algo'`, matchea con `~` y extrae el id con `substring`, y un B-tree sobre el valor
completo no responde ninguna de las dos cosas. Eran tres índices que nunca se usaban sobre una tabla de
escritura activa. Si con volumen real hace falta, el correcto es de expresión y va en una 017 medida: el
comentario del DDL lo tiene escrito.

**La base local está atrasada.** Verificado: tiene aplicadas la 001 a la 010 y le faltan la 011 a la
015. Antes de probar la 016 en local hay que correr `npm run db:migrate`, que va a aplicar seis
migraciones de una. No te sorprendas ni asumas que la 011-015 no existen.

**Después de migrar, corré `tasks/anuncios/_verificacion-016.sql`.** Prueba las 14 afirmaciones de las
que dependen T14, T15, T16 y T18, y corrió en verde. Si algo no da lo que dice su `\echo`, el
problema está en tu migración.

```bash
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < tasks/anuncios/_verificacion-016.sql
```

**Y leé la salida, no solo el exit code.** Sólo los bloques 1, 2, 3, 10, 12 y 13 tiran excepción si
fallan; los otros ocho imprimen y hay que comparar contra su `\echo`. Un archivo que "corre en verde" no
garantiza que los números impresos sean los esperados: así fue como ese mismo archivo tuvo durante semanas
un §7 que calculaba el presupuesto con la fórmula equivocada sin que nadie lo notara.

## 4. `lib/ads/tipos.ts` — los contratos

**El archivo más importante del módulo.** Contiene los tres contratos de §4, §5 y §6 del plan, tal
como están escritos ahí. Seis tasks lo importan y **ninguna lo puede modificar**, así que tiene que
quedar completo aunque este task no use ni una de sus firmas.

Copiá de §4 del plan: `NivelAds`, `MetricasObjeto` (con `budgetMode`), `PeriodoAds`, `FiltrosAds` (con
`limit` y `after`) y la firma de `getMetricasAds`. De §5: `Regla`, `Condicion`, `MotivoOmision`,
`Decision` y la firma de `evaluar`. De §6: `MetaCampaign`, `MetaAdSet`, `MetaAd`, `ResultadoEscritura` y
las firmas del cliente.

**`MetaAdSet` y `MetaAd` están escritos completos en §6 del plan. Copialos como están.** En la versión
anterior eran `export type MetaAdSet = { /* + optimizationGoal, billingEvent, campaignId */ };`, o sea un
objeto vacío con un comentario: compila, no dice nada, y deja que T14, T15 y T17 inventen tres
interpretaciones distintas del mismo contrato mientras cada una afirma haberlo seguido. Si un tipo del
plan tiene un `{ /* ... */ }`, **no está congelado**: está sin escribir, y hay que resolverlo antes de que
arranque la ola A, no después.

Lo mismo con la firma del stub de `lib/queries/ads.ts`: el tipo de retorno va **completo**, no
`Promise<{ /* …§4 del plan… */ }>`. Un `Promise<{}>` compila y acepta cualquier cosa.

Solo tipos y firmas. **Ninguna implementación vive acá**: las funciones se declaran en sus módulos
(`lib/queries/ads.ts`, `lib/ads/reglas/motor.ts`, `lib/ads/meta.ts`) y este archivo define las formas
que cruzan fronteras entre tasks.

### Y además: el stub de `lib/queries/ads.ts`

T15 y T16 corren en paralelo, y `lib/ads/reglas/ejecutor.ts` (de T16) importa `getMetricasAds` de
`lib/queries/ads.ts` (de T15). **Un import a un archivo que no existe no compila**, así que T16 no
podría correr su verificación. Es el mismo problema que el plan original resolvió con `app/layout.tsx`
entre T01 y T05, y se resuelve igual: T13 deja un stub.

```ts
// T15 reemplaza este archivo completo.
import type { FiltrosAds, MetricasObjeto } from '@/lib/ads/tipos';

export async function getMetricasAds(f: FiltrosAds): Promise<{
  filas: MetricasObjeto[];
  hayMas: boolean;
  sinAtribuir: { sales: number; revenueEur: number };
  rango: { from: string; to: string; timezone: string };
  generatedAt: string;
}> {
  throw new Error('lib/queries/ads.ts: todavía es el stub de T13, lo implementa T15');
}
```

**El tipo de retorno va escrito, no `{ /* …§4… */ }`.** Con el placeholder, TypeScript infiere `{}` y
acepta que T15 devuelva cualquier forma: el stub deja de ser un contrato y pasa a ser un comentario.

**Tira, no devuelve un array vacío.** Un stub que devolviera `{ filas: [] }` haría que T16 pase sus
tests contra datos inexistentes y nadie se enteraría hasta que el motor no encuentre nada en
producción. Que falle ruidosamente es la única forma de que el error aparezca en el momento correcto.

El comentario de la primera línea es obligatorio: es lo que le dice a T15 que ese archivo se **reemplaza
completo**, no se edita.

Tres puntos que se documentan en el archivo con un comentario, porque son los que se van a
malinterpretar:

1. **`roas` y `roi` de `MetricasObjeto` no son el `roi` de `lib/queries/sales.ts`.** Ahí significa
   `resultado / gasto_total`; acá `roi = neto / gasto`. Poné la advertencia de D-A7 del plan como
   comentario arriba de los dos campos: cuatro tasks van a leer este archivo y ninguna va a leer
   `sales.ts`.
2. **`null` en una métrica significa "no se puede calcular", no cero.** Un objeto con €0 de gasto no
   tiene ROI. Si se devuelve `0`, la condición `ROI < 1.1` se cumple y una regla pausa un conjunto que
   todavía no gastó nada. Es el falso positivo más caro del motor.
3. **Los presupuestos de `MetaCampaign`/`MetaAdSet` están en unidades mínimas** (céntimos), tal como
   los devuelve Meta; los de `MetricasObjeto` y `Regla` están en **EUR**. La conversión se hace en un
   solo lugar y hay que decir en qué unidad está cada campo, en el campo mismo.

## 4b. `lib/ads/meta.ts` — el token sale de la URL. Esto va PRIMERO.

Antes de agregar un solo lector nuevo, migrá **todas** las llamadas a `Authorization: Bearer` (D-A3).
Hoy el token va en el query string, en los dos lugares que arman URL (`lib/ads/meta.ts:98` y `:143`).

**Por qué ahora y no "cuando toque la escritura".** El plan anterior decía que en las lecturas de gasto
era tolerable. Deja de serlo en el momento exacto en que este task le confirma `ads_management` al mismo
token: a partir de ahí cada URL de lectura transporta una credencial que puede apagar la facturación, y
las URLs terminan en logs de acceso, mensajes de error, trazas y proxies. Separar sólo el POST no baja el
privilegio de lo que se filtra.

**Esto NO toca `lib/ads/sync.ts`.** La firma de `fetchInsights` no cambia; cambia cómo arma el request
por dentro. `lib/ads/meta.ts` está en la fila de T13 (§8 del plan), así que entra en tu alcance.

### La trampa de la paginación, que es donde el cambio se rompe solo

`pedir()` sigue `paging.next` **tal como lo devuelve Meta** (hoy en `lib/ads/meta.ts:170`), y esa URL
**trae el `access_token` adentro**. Migrar la primera llamada al header y después seguir el cursor
verbatim deja el token en la URL de todas las páginas menos la primera, que es peor que no haber hecho
nada porque parece resuelto.

Dos salidas válidas:

1. **Reconstruir la URL**: leer `paging.cursors.after` y volver a armar la query con `after=<cursor>`.
2. **Limpiar el cursor**: parsear `paging.next` y borrarle el parámetro `access_token`.

```ts
// Opción 2, que es menos código y sobrevive a que Meta agregue parámetros:
function limpiarCursor(next: string): string {
  const u = new URL(next);
  u.searchParams.delete('access_token');
  return u.toString();
}
```

**El test verifica que NINGUNA url que sale del módulo contiene `access_token`, no que la primera no la
contiene.** Es criterio global §9.7c del plan. La forma barata: envolver `fetch` en el test y juntar
todas las URLs que pasaron.

```ts
// lib/ads/meta.test.ts — el test que hace que este cambio no se deshaga solo
it('nunca pone el token en la URL, ni siguiendo la paginación', async () => {
  const urls: string[] = [];
  // stub de fetch que devuelve dos páginas: la segunda llega por paging.next,
  // que en la respuesta real de Meta viene CON el access_token adentro.
  // ...
  expect(urls.some((u) => u.includes('access_token'))).toBe(false);
  expect(urls.length).toBeGreaterThan(1);   // que de verdad paginó
});
```

Y el corolario para los errores: **`MetaAdsError` no puede llevar la URL en el mensaje**. Hoy no la
lleva; que siga así es parte de esta decisión.

### El sobre de error crece cuatro campos (§6b del plan)

`MetaAdsError` conserva hoy `message`, `code` y `type` y descarta el resto. El backoff de T18 tiene que
distinguir un throttle transitorio de un error permanente de permisos, y con `code` solo no puede:

```ts
export class MetaAdsError extends Error {
  readonly code?: number;
  readonly type?: string;
  readonly subcode?: number;      // error_subcode: distingue 17/2446079 de otro 17
  readonly transient?: boolean;   // is_transient: reintentar o parar
  readonly traceId?: string;      // fbtrace_id: es lo que Meta pide si hay que reportar
  readonly httpStatus?: number;   // hoy se descarta y es lo primero que se mira
}
```

Los cuatro salen del mismo `body.error` que ya se parsea, más `res.status`. Son cuatro líneas.

### La versión de la API sale de una env var (D-A16b)

```ts
const API_VERSION = (() => {
  const v = process.env.META_API_VERSION ?? 'v21.0';
  if (!/^v\d+\.\d+$/.test(v)) throw new MetaAdsError(`META_API_VERSION inválida: ${v}`);
  return v;
})();
```

Validada contra el formato para que un typo no produzca una URL rarísima con un 404 confuso. El sunset
de `v21.0` cae alrededor de principios de 2027 y no se pudo confirmar la fecha exacta (P-A10): la página
oficial de changelog devuelve error SSL. Que la versión sea un env var es lo que hace que subirla no
requiera un deploy de código.

## 5. `lib/ads/meta.ts` — lectura de la jerarquía

Se **extiende** el archivo que ya existe. Después del §4b, su `pedir()` autentica por header; su
paginación con cortafuegos de 100 páginas, su timeout de 30 s y `fetchInsights` siguen funcionando igual
por fuera y no cambian de firma.

Agregá tres lectores, todos con paginación completa:

```
GET /act_{id}/campaigns
  fields=id,name,objective,status,effective_status,daily_budget,lifetime_budget,
         bid_strategy,created_time
GET /act_{id}/adsets
  fields=id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,
         optimization_goal,billing_event,bid_strategy,created_time
GET /act_{id}/ads
  fields=id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id}
```

`limit=200` y seguir `paging.next` hasta el final, con el mismo cortafuegos que `fetchInsights`. Una
cuenta con muchos anuncios que devuelve solo la primera página deja media jerarquía sin sincronizar y
**sin ningún error visible**: es el modo de falla que hay que evitar.

**`effective_status` se pide siempre, en los tres.** `status` es lo configurado y lo único escribible;
`effective_status` es lo que Meta dice que pasa de verdad y agrega valores que no se pueden escribir
(`CAMPAIGN_PAUSED`, `ADSET_PAUSED`, `WITH_ISSUES`, `DISAPPROVED`, `PENDING_REVIEW`, `IN_PROCESS`,
`PENDING_BILLING_INFO`). Sin el segundo, el panel muestra "activo" para un conjunto cuya campaña está
pausada y el usuario no entiende por qué no gasta.

**Cómo se detecta si el presupuesto es de campaña o de conjunto** (D-A5, es el dato que decide a qué
id se le pega): si la campaña trae `daily_budget` o `lifetime_budget` con valor, es presupuesto de
campaña (CBO / Advantage campaign budget) y **escribir en el conjunto falla**. Si vienen en `null`, el
presupuesto vive en cada conjunto (ABO). No hay un campo que lo diga directamente: se infiere de la
presencia del presupuesto, y esa inferencia se guarda en `ad_campaigns.budget_level`.

### Moneda y zona de la cuenta, que deciden si la cuenta se procesa

```
GET /act_{id}?fields=currency,timezone_name,account_status
```

`fetchCuenta` devuelve eso. **Una cuenta cuyo `currency` no sea `EUR` no se procesa** (D-A10): el módulo
escribe `daily_budget` en unidades mínimas de la moneda de la cuenta y el contrato entero dice `Eur`. Con
otra moneda, el `× 100` de la UI escribe un importe equivocado sin ningún error. Se reporta y se sigue con
las demás, no se convierte nada.

### El mínimo de presupuesto de la cuenta — CONTRATO NO VERIFICADO, LEER ESTO

La versión anterior de este task pedía:

```
GET /act_{id}?fields=min_daily_budget_low_freq,min_daily_budget_high_freq   ← ESTOS CAMPOS NO EXISTEN
```

**No existen.** No están documentados en la referencia de `AdAccount` ni en el objeto `AdAccount` del SDK
oficial, y el plan no aportaba endpoint, versión ni respuesta real que los respaldara. El resultado
habría sido uno de dos, y el segundo es el malo: o la fundación falla en la primera consulta, o alguien
"arregla" el error inventando una lógica de mínimos que después se usa como protección monetaria.

Lo que **sí** está documentado es una edge dedicada:
[`GET /act_{id}/minimum_budgets`](https://developers.secure.facebook.com/docs/marketing-api/reference/ad-account/minimum_budgets/).

**Probala contra una cuenta real y recién ahí congelá el shape.** Qué campos trae, en qué unidad, y si
varía por objetivo o por `billing_event` son cosas que hay que ver, no deducir:

```bash
curl -sG "https://graph.facebook.com/$V/$ADS_TEST_ACCOUNT/minimum_budgets" \
  -H "Authorization: Bearer $T" | python3 -m json.tool
# Pegá la respuesta REAL en P-A11 del plan. Es el único insumo que congela este contrato.
```

Hasta que eso esté hecho, `fetchMinimoPresupuesto` **devuelve `null`** y el piso lo pone el usuario con
`budget_min`. Y la regla que no se negocia: **`null` es "no sé el mínimo", nunca "el mínimo es 0"**.
Tratarlo como 0 hace que una regla de bajar presupuesto pida €0,10 y Meta rechace la llamada; peor, hace
que un piso inexistente parezca un piso verificado.

**No inventes un mínimo por defecto** (ni €1,00, ni el que diga un blog). Un número inventado que se
comporta como protección es peor que no tener protección, porque nadie lo vuelve a mirar.

## 6. `lib/ads/meta.ts` — escritura

Dos funciones, y las dos son las que pueden costar plata.

```ts
/** POST /{objectId} con status. Solo ACTIVE y PAUSED. */
export async function setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>;

/** POST /{objectId} con daily_budget en unidades mínimas de la moneda de la cuenta. */
export async function setDailyBudget(objectId: string, unidadesMinimas: number): Promise<void>;
```

Cinco reglas, ninguna opcional:

**1. El token va en el header, y para este punto `pedir()` ya lo hace también** (§4b). Para escritura
escribí una `enviar()` aparte, porque el método, el body y el manejo del timeout son distintos:

```ts
const res = await fetch(`${BASE}/${objectId}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ status }),
  signal: AbortSignal.timeout(30_000),
});
```

Las URLs completas terminan en logs de acceso, en mensajes de error y en cualquier proxy del camino.
Un token con `ads_management` filtrado es control total de la cuenta publicitaria: no es lo mismo que
filtrar uno de solo lectura.

**2. `ARCHIVED` y `DELETED` no existen en la firma.** Son irreversibles desde la API y no hay ningún
caso de uso que los pida. Que el tipo lo haga imposible es más barato que revisarlo en cada llamador.

**3. `unidadesMinimas` tiene que ser un entero.** Meta rechaza decimales con un error de validación
que en el log parece un problema de permisos. Validá con `Number.isInteger()` y tirá `MetaAdsError`
antes de salir a la red: un error propio dice qué pasó, el de Meta no.

**4. Un `unidadesMinimas <= 0` es un bug del llamador, no un pedido válido.** Rechazalo con
`MetaAdsError` local. Poner un presupuesto en 0 no pausa nada: es un valor inválido y Meta lo
rechaza, pero para cuando lo rechaza ya gastaste una llamada de cuota.

**5. La respuesta se verifica.** Meta devuelve `{"success":true}` y también puede devolver 200 con un
`error` en el body. La `pedir()` que existe ya maneja ese caso: seguí el mismo patrón en `enviar()`,
tratando "HTTP ok pero hay `error` en el body" como un fallo.

**6. Un timeout NO es un fallo: es un resultado desconocido, y la firma tiene que dejar distinguirlo.**
Un POST que corta a los 30 s **puede haberse aplicado en Meta igual**. Si `enviar()` tira el mismo error
para "Meta dijo no" y para "no sé", el llamador no puede decidir distinto, y el tick siguiente reintenta
sobre un objeto que quizás ya se movió: así una subida de presupuesto se aplica dos veces.

```ts
/** Lo que enviar() tiene que dejar distinguir. §6c del plan depende de esto. */
export type ResultadoEscritura =
  | { estado: 'confirmado' }
  | { estado: 'fallido'; error: MetaAdsError }
  | { estado: 'indeterminado'; error: MetaAdsError };   // timeout o error de red
```

Un `AbortError` del `AbortSignal.timeout`, un `ECONNRESET` o un 5xx sin body van a `indeterminado`. Un
error de Meta con `code` (permisos, presupuesto inválido, cuota) va a `fallido`: ahí Meta procesó el
pedido y lo rechazó, no pasó nada en la cuenta.

**7. Y también hay que poder LEER un objeto suelto**, porque es lo único que resuelve un
`indeterminado`: se le pregunta a Meta, que es el source of truth.

```ts
export async function fetchObjeto(objectId: string, level: NivelAds): Promise<{
  objectId: string; status: string | null; effectiveStatus: string | null;
  dailyBudget: number | null; lifetimeBudget: number | null;
} | null>;
```

**8. Un contador de llamadas, para que el criterio §9.7 del plan sea verificable.** El plan promete que
con `ads_rules_enabled = false` el worker no hace "ni una llamada a Meta", y eso no se verifica leyendo
código. Exportá un contador que el worker imprime al final del tick:

```ts
export function contadorLlamadas(): { total: number; porCuenta: Record<string, number> };
export function reiniciarContador(): void;
```

Son diez líneas y convierten una promesa del plan en un número que se mira.

## 7. Los headers de uso, para que T18 pueda frenar

Meta informa cuánta cuota se consumió en **cada respuesta**, y con la cadencia de un minuto que pidió
el usuario (D-A13) eso es lo único que evita que la API corte el servicio en el peor momento. T18
implementa el backoff, pero **la lectura del header es de este task** porque vive en el cliente.

```ts
export function ultimoUso(accountId: string): {
  callCount: number; totalTime: number; totalCPUTime: number;
  regainAccessAt: Date | null;
} | null;
```

**Lleva `accountId`, y eso es lo importante.** La versión anterior guardaba "la última respuesta" en un
`let` global sin identificar la cuenta. Con dos cuentas eso rompe el backoff de la forma más silenciosa
posible: la cuenta A está al 92% y contesta, después llega una respuesta sana de la cuenta B, el `let` se
sobrescribe con el 12% de B, y el worker concluye que hay cuota de sobra y sigue golpeando a A hasta que
Meta la corta. El síntoma que se ve es "el backoff no funciona", y la causa está a tres archivos de
distancia.

Así que el estado es un `Map<string, Uso>`, poblado en `pedir()` y en `enviar()` con la cuenta a la que
pertenecía la llamada. Sigue siendo estado global mutable a propósito y por la misma razón que antes: el
que necesita el dato (el worker) no es el que hace la llamada (el sync), y pasarlo por el tipo de retorno
obligaría a cambiar la firma de `fetchInsights`, que está congelada porque `lib/ads/sync.ts` la usa y
**`sync.ts` no se toca**.

Para las llamadas que no son de una cuenta (`/me/adaccounts`, `debug_token`) usá una clave reservada
como `'_app'`. Que el `Map` no tenga entrada para una cuenta significa "todavía no le hablé", que es
distinto de "está al 0%": devolvé `null`.

Se lee de `x-business-use-case-usage`. El header es un JSON con el id del negocio como clave y un array
de objetos con `type`, `call_count`, `total_time`, `total_cputime` y `estimated_time_to_regain_access`
(en minutos). Los tres primeros son porcentajes de 0 a 100.

Si el header no viene o no parsea, devolvé `null`. Nunca tires desde acá: es telemetría, y un cambio
de formato en un header de Meta no puede dejar el panel sin gasto.

Documentá en un comentario los dos errores de cuota que T18 va a tener que reconocer:
`code 17 / subcode 2446079` ("User request limit reached") y `code 613 / subcode 1487742` ("too many
calls from this ad-account"). **El subcódigo ahora se puede leer** porque `MetaAdsError` lo conserva
(§4b): sin él, un `17` de cuota de usuario y otro `17` de cualquier otra cosa son indistinguibles y el
backoff castiga o perdona al azar.

## 8. `scripts/verificar-token-ads.ts`

La automatización de lo que hiciste a mano en §2, para que se pueda correr en cada deploy.

```
npm run ads:token
```

1. Llama a `verificarPermisos()`: `debug_token` para listar `scopes`, y devuelve qué falta. Imprime
   también **la versión de la Graph API en uso** (D-A16b): un deploy no puede quedar apuntando a una
   versión retirada sin que nadie lo vea.
2. Lista las cuentas activas de `ad_accounts` e imprime la **moneda** y la **zona horaria** de cada una:
   - **avisa si `currency` no es `EUR`**, porque esa cuenta no se va a procesar (D-A10);
   - **avisa si `timezone` está en `NULL`** (P-A03: sin ese dato las métricas agrupan mal el día).
3. Hace la escritura no-op (`status=PAUSED`) **sólo sobre el objeto de la allowlist**, y reporta si pudo.
4. Sale con código **1** si el token no puede escribir sobre el objeto autorizado. Es lo que lo hace
   usable desde `deploy.sh`.
5. **No imprime el token**, ni entero ni parcial.
6. Imprime qué cuenta y qué objeto usó para probar, para que ese dato quede en el log del deploy en lugar
   de en la cabeza de alguien.

### El objeto de prueba es una allowlist explícita, no una búsqueda

```bash
ADS_TEST_OBJECT_ID=120210000000000    # en .env / .env.production. Sin esto, no prueba escritura.
```

**El script NO busca "la primera campaña pausada".** Eso es lo que hacía la versión anterior de este task
y es una prueba de instalación que escribe sobre un objeto real elegido por orden de listado. Que la
escritura sea un no-op no vuelve segura la selección.

Comportamiento sin `ADS_TEST_OBJECT_ID`:

- reporta **"escritura no verificada: falta ADS_TEST_OBJECT_ID"**,
- sale con **0**, no con 1: no es un fallo del token, es una configuración que falta,
- **y deja claro en la salida que el permiso de escritura NO quedó demostrado**, para que nadie lea un
  exit 0 como luz verde.

Antes de escribir, el script **relee el objeto** y verifica dos cosas: que exista y que su `status` sea
`PAUSED`. Si está activo, no le escribe: reporta que el objeto de la allowlist ya no está pausado y sale
con 1. Un no-op sobre algo activo no es un no-op.

## 9. `package.json` y `.env.example`

**Declará los cuatro scripts de una sola vez**, aunque tres apunten a archivos que T14, T16 y T18 van
a crear. Es la única forma de que ningún otro task tenga que tocar `package.json` (§8 del plan). Que
un script apunte a un archivo inexistente no rompe el build.

```json
"ads:token":     "tsx scripts/verificar-token-ads.ts",
"ads:jerarquia": "tsx scripts/sync-ads-jerarquia.ts",
"ads:reglas":    "tsx scripts/run-ad-rules.ts",
"ads:telegram":  "tsx scripts/telegram-setup.ts"
```

**Ni una dependencia nueva** (D-A18). Todo con `pg`, `zod`, el `fetch` nativo de Node 20 y el kit de
UI que ya está. Si te parece que falta un paquete, va a §10 del plan.

En `.env.example`, agregá el bloque de anuncios **documentando también las tres variables que el
código ya lee y que nunca se documentaron**:

```bash
# ── Publicidad (Meta Marketing API) ───────────────────────────────
# Usuario del sistema con ads_read Y ads_management, y la cuenta asignada con
# rol de administrador. NO es el token de CAPI de los funnels: ese solo tiene
# read_ads_dataset_quality y /me/adaccounts le devuelve "(#200) Missing
# Permissions". Verificar con: npm run ads:token
#
# OJO: hoy esta variable NO está en el .env local, solo en el .env.production de
# la VPS, y nunca se documentó. Sin ella, las verificaciones de este módulo
# salen con access_token vacío y Meta contesta algo sobre credenciales que
# manda a buscar un problema de permisos que no existe.
META_ADS_TOKEN=
# Versión de la Graph API. Configurable a propósito: el sunset de v21 cae
# alrededor de principios de 2027 y subir de versión no puede requerir un
# deploy de código. Formato vXX.Y, validado al arrancar.
META_API_VERSION=v21.0
# ALLOWLIST del objeto sobre el que `npm run ads:token` puede escribir su no-op.
# Una campaña o conjunto PAUSADO y descartable, elegido a mano. Sin esto, el
# script reporta que la escritura no quedó verificada y NO elige uno solo.
ADS_TEST_OBJECT_ID=
# Refresco del gasto en el render, cuando el rango incluye hoy.
ADS_LIVE_TTL_SECONDS=60
ADS_LIVE_TIMEOUT_MS=8000
```

**`META_ADS_TOKEN` también hay que agregarlo al guard de `deploy/deploy.sh`.** Su lista `REQUIRED` tiene
hoy cuatro variables (`DATABASE_URL`, `DASHBOARD_PASSWORD`, `NEXT_PUBLIC_SITE_URL`,
`SHOPIFY_WEBHOOK_SECRETS`) y el token de ads no está: un deploy con la variable ausente pasa el guard y
el worker falla en cada tick. **Ese archivo es de T18** (§8 del plan), así que **no lo edites**: anotalo
para T18, que lo tiene en su §10.

Las reglas, el interruptor general, el modo sombra y las credenciales de Telegram **no van al env**:
viven en `settings` (D-A12, D-A15) para poder cambiarse desde el panel sin desplegar.

## 10. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — EL BLOQUEANTE: el token puede escribir
npm run ads:token
# esperado: una línea OK por cuenta activa y exit 0.
# Si sale 1, PARÁ acá y anotá en P-A01. Nada más de este módulo tiene sentido.

# 2 — compila
npx tsc --noEmit
npm run build

# 3 — la migración se aplica y es idempotente
npm run db:migrate
npm run db:migrate                  # la segunda vez: "0 aplicadas", exit 0

# 4 — las 7 tablas nuevas existen
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND table_name IN ('ad_campaigns','ad_sets','ads','ad_rules',
                         'ad_rule_conditions','ad_rule_runs','ad_actions')
    ORDER BY 1;"
# esperado exactamente 7 líneas:
#   ad_actions / ad_campaigns / ad_rule_conditions / ad_rule_runs / ad_rules / ad_sets / ads

# 5 — los 18 CHECK de ad_rules están
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM pg_constraint
    WHERE conrelid='ad_rules'::regclass AND contype='c';"
# esperado exactamente: 18
# (eran 15 antes de la revisión; los tres nuevos son ad_rules_percent_direccion,
#  ad_rules_techo_sobre_piso y ad_rules_limites_positivos)

# 5b — LOS TRES CHECK NUEVOS SON LOS QUE IMPIDEN QUE UNA REGLA HAGA LO CONTRARIO
#      DE SU NOMBRE. Verificá que estén por nombre, no solo por cantidad:
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT conname FROM pg_constraint WHERE conrelid='ad_rules'::regclass
     AND conname IN ('ad_rules_percent_direccion','ad_rules_techo_sobre_piso',
                     'ad_rules_limites_positivos','ad_rules_mlevel_valido')
   ORDER BY 1;"
# esperado exactamente 4 líneas. Un budget_increase con 50% (que PARTE el
# presupuesto al medio) tiene que ser imposible de guardar.

# 6 — los settings nacieron en el lado seguro (D-A12) y los topes existen (D-A9c)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT key||'='||value::text FROM settings
    WHERE key IN ('ads_rules_enabled','ads_rules_force_dry_run',
                  'ads_max_daily_budget_eur','ads_max_delta_por_tick_eur') ORDER BY key;"
# esperado exactamente:  ads_max_daily_budget_eur=200
#                        ads_max_delta_por_tick_eur=300
#                        ads_rules_enabled=false
#                        ads_rules_force_dry_run=true

# 6a — las 14 filas de settings del módulo (eran 10 antes de la revisión)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM settings WHERE key LIKE 'ads_%';"
# esperado exactamente: 14

# 6a2 — el lease nace como objeto vacío, no como string vacío (D-A13)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT value::text FROM settings WHERE key='ads_worker_lease';"
# esperado exactamente: {}
# Si dice "" quedó el formato viejo y el lease con dueño de T18 no va a funcionar.

# 6b — LAS SEIS REGLAS DEL USUARIO se cargaron, apagadas y en sombra
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT name, enabled, dry_run, level||'/'||status_filter AS alcance, action,
          action_value, budget_max, period, every_minutes,
          (SELECT count(*) FROM ad_rule_conditions c WHERE c.rule_id = r.id) AS cond
     FROM ad_rules r ORDER BY r.id;"
# esperado: 6 filas, TODAS con enabled=f y dry_run=t.
# Las tres de escalado con action_value = 250 (NO 2.5 y NO 350) y techos 25/75/150.
# Condiciones: 1 · 4 · 4 · 2 · 2 · 2 = 15 en total.

# 6c — ningún monto quedó en céntimos (el error de traducción más caro)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM ad_rule_conditions
    WHERE metric IN ('spend','budget','revenue','net','profit','cpa','cpc') AND value > 150;"
# esperado exactamente: 0
# Si es > 0, un umbral quedó en céntimos y esa regla nunca se va a disparar.

# 6d — el seed es idempotente: correr la migración dos veces no duplica nada
#      (ya lo cubre la verificación 3, pero esto lo mira desde las reglas)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*)||' reglas · '||(SELECT count(*) FROM ad_rule_conditions)||' condiciones'
     FROM ad_rules;"
# esperado exactamente: 6 reglas · 15 condiciones

# 7 — la verificación lógica del plan, en verde
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < tasks/anuncios/_verificacion-016.sql
# los 14 bloques tienen que dar lo que dice su \echo.
#
# LEELOS. Solo los bloques 1, 2, 3, 10, 12 y 13 tiran excepción si fallan; los
# demás IMPRIMEN y hay que comparar contra el \echo. Ese es exactamente el
# agujero por el que ese archivo tuvo durante semanas un §7 que calculaba el
# presupuesto con la fórmula equivocada y "corría en verde".
#
# El §7 tiene que dar: 2500 | 2500 | 2500 | 3325 | 2600 | 2400 | 100
# Si el primero da 3500, alguien volvió a la lectura de incremento (D-A9).

# 7b — el stub de lib/queries/ads.ts existe, se importa y TIRA (§4)
grep -c "T15 reemplaza este archivo completo" lib/queries/ads.ts   # esperado: 1
npx tsx -e "
  import('./lib/queries/ads').then(m =>
    m.getMetricasAds({ level: 'campaign', period: 'today' })
      .then(() => console.log('MAL: el stub devolvió datos en lugar de tirar'))
      .catch(e => console.log('OK — el stub tira:', e.message))
  );
"
# esperado: 'OK — el stub tira: ... todavía es el stub de T13 ...'
# Si devuelve datos o un array vacío, T16 va a pasar sus tests contra datos
# inexistentes y nadie se va a enterar hasta producción.

# 8 — la lectura de jerarquía trae datos reales
npx tsx -e "
  import('./lib/ads/meta').then(async (m) => {
    const cs = await m.fetchCampaigns(process.env.CUENTA!);
    console.log('campañas:', cs.length);
    console.log('con presupuesto diario de campaña (CBO):', cs.filter(c => c.dailyBudget !== null).length);
    console.log('con presupuesto TOTAL (lifetime, no soportado para escribir):',
                cs.filter(c => c.lifetimeBudget !== null).length);
    console.log(cs.slice(0, 3).map(c => ({ n: c.name, s: c.status, e: c.effectiveStatus, b: c.dailyBudget })));
  });
"
# esperado: campañas > 0.
# Anotá cuántas tienen lifetime: si hay, T14 y T16 las tienen que rechazar
# explícitamente (D-A10) en lugar de intentar escribirles daily_budget.
#
# Si TODAS tienen effectiveStatus === status, NO es un fallo: es posible que la
# cuenta esté toda en el mismo estado. Verificá que estás pidiendo el campo
# (grep 'effective_status' lib/ads/meta.ts) y anotalo para T17, que necesita ese
# caso para probar su badge.

# 8b — EL TOKEN NO VIAJA EN NINGUNA URL, NI EN LA PAGINACIÓN (§9.7c del plan, D-A3)
npm test -- lib/ads/meta.test.ts
grep -n "access_token" lib/ads/meta.ts
# esperado: CERO líneas de grep. Si aparece una, el token sigue en el query
# string y el criterio 7c del plan no se cumple. Ojo especialmente con el
# seguimiento de paging.next: Meta devuelve ese cursor CON el token adentro, así
# que hay que limpiarlo (§4b).

# 8c — la versión de la API es configurable y se valida (D-A16b)
META_API_VERSION=basura npx tsx -e "import('./lib/ads/meta').catch(e => console.log('OK:', e.message))"
# esperado: un error propio diciendo que META_API_VERSION es inválida.
# Si en cambio sale a la red y devuelve un 404 de Meta, falta la validación.

# 9 — NO SE ROMPIÓ NADA de lo que ya funcionaba
#     Anotá estos dos números ANTES de migrar y compará después:
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*), coalesce(sum(spend_eur),0) FROM ad_spend;"
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*), coalesce(sum(amount_eur),0) FROM orders;"
# tienen que ser idénticos antes y después. Si cambiaron, la migración no fue
# aditiva y hay que revertir.

# 10 — tests
npm test

# 11 — no se tocó nada fuera de la fila T13 de §8 del plan
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
#
# esperado: db/migrations/016_ads_gestion.sql, lib/ads/tipos.ts, lib/ads/meta.ts,
# lib/ads/meta.test.ts, scripts/verificar-token-ads.ts, package.json,
# .env.example y lib/queries/ads.ts (el stub). Nada más.
# Si aparece README.md, revertilo: no está en el ownership de T13.
# Si aparece deploy/deploy.sh, revertilo: es de T18 (le dejaste una nota en §10).
```

## 11. Cuándo parar

**Bloqueante, pará y avisá:**

- **El token no puede escribir** (verificación 1). Es P-A01 y es la razón por la que este task existe
  antes que los otros seis. No sigas "dejando la escritura para después": si el permiso no está, el
  diseño de las reglas puede tener que cambiar.
- **Queda una sola aparición de `access_token` en `lib/ads/meta.ts`** (verificación 8b). No es un detalle
  de estilo: este task es el que le confirma `ads_management` al token, así que es el que convierte cada
  URL de lectura en una credencial capaz de mover dinero. No sigas y no lo dejes "para el final".
- La migración no es idempotente, o los conteos de `ad_spend` / `orders` de la verificación 9
  cambiaron. Estás sobre datos vivos.
- **El preflight de `orders` (§3) da un número grande y migraste igual.** Si la tabla resulta ser mucho
  más grande de lo que el plan suponía, pará, avisá, y creá el índice con `CONCURRENTLY` antes. Colgar los
  INSERT de pedidos es un problema de facturación, no de desarrollo.
- `npm run build` no pasa. Seis tasks van a construir encima.

**Anotalo en §10 del plan y seguí:**

- `ad_accounts.timezone` está en `NULL` en alguna cuenta (P-A03). Anotalo y dejá corriendo
  `refrescarMetadatosCuentas()` una vez; no bloquea a este task pero sí falsea las métricas de T15.
- La zona de las cuentas no es la que dijo el usuario, o no coincide con la del funnel. Anotá los
  valores reales de las dos: T15 los necesita.
- `debug_token` no funciona con este token pero la escritura no-op sí. Es normal con algunos tokens de
  usuario del sistema. Anotalo para que nadie más lo investigue de nuevo.
- Meta devuelve un campo que el §6 del plan no previó y que parece útil. **No lo agregues al contrato:**
  anotalo. Cambiar `lib/ads/tipos.ts` después de que arranque la ola A rompe tres tasks a la vez.
