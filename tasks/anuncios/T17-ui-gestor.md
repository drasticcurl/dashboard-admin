# T17 — UI del gestor de anuncios y acciones manuales

- **Depende de:** T13 (contratos), T14 (la jerarquía cargada) y T15 (`getMetricasAds`).
- **Bloquea:** nada. T19 importa su `SubNav.tsx` pero no lo modifica.
- **Se puede correr en paralelo con:** T18 y T19.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `app/(panel)/anuncios/page.tsx`,
  `app/(panel)/anuncios/AnunciosView.tsx`, `app/(panel)/anuncios/SubNav.tsx`,
  `app/api/data/ads/route.ts`, `app/api/ads/acciones/route.ts` y `components/Nav.tsx`. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo, y **antes de escribir una línea de UI leé
`app/(panel)/ventas/page.tsx`, `app/(panel)/ventas/VentasView.tsx` y `components/ui.tsx` enteros.**
Esta pantalla es la hermana de Ventas: mismo esqueleto, mismos componentes, mismo tema.

---

## 1. Objetivo

La pantalla `/anuncios`: la tabla de campañas, conjuntos y anuncios con la plata real al lado, el
toggle de estado, el presupuesto editable y las acciones en lote. Más los dos endpoints que la
alimentan.

Es la referencia visual de la primera captura que pasó el usuario: filtros arriba, y una tabla con
**estado · nombre · presupuesto · últ. actualización · ventas · CPA · gastos · ingresos · ganancia ·
ROAS · ROI**.

Este task **no crea reglas, no evalúa nada y no arma el worker.** Solo muestra y deja actuar a mano.

## 2. El patrón de pantalla del proyecto — se copia, no se reinventa

Todas las secciones del panel están hechas igual y esta no es la excepción:

- **`page.tsx`** es un server component con `export const dynamic = 'force-dynamic'`. Lee
  `searchParams`, hace el fetch inicial y pasa `initialData` a la vista.
- **`AnunciosView.tsx`** es `'use client'`. Recarga vía `fetch('/api/data/ads?...')` cuando cambian
  los filtros, sin navegar.
- Los filtros viven en el **query string** y se cambian con `router.replace(..., { scroll: false })`
  **preservando todo lo que ya había**. Es lo que hace que `?f=` y `?range=` sobrevivan.
- Todo con el kit de `components/ui.tsx`: `Card`, `StatCard`, `Badge`, `Banner`, `Table<T>`,
  `Column<T>`, `Spinner`, `EmptyState`, `fmtInt`, `fmtPct`, `fmtMoney`, `fmtDate`, `fmtDateTime`,
  y el tipo `Tone`.

**`components/ui.tsx` NO se modifica** (D-A19). Cuatro tasks lo importan. Los dos controles que faltan
—el toggle de estado y el campo de presupuesto editable— viven **dentro de `AnunciosView.tsx`**.

Una diferencia importante con Ventas: **el selector de funnel del `Nav` no aplica acá.** Las cuentas
publicitarias se filtran por cuenta, no por funnel (E16: el usuario descartó el filtro por producto).
Ignorá `?f=` en esta pantalla y no lo escondas: poné el selector de cuenta propio en los filtros.

## 3. `components/Nav.tsx` — la pestaña nueva

Un cambio de una línea en el array `TABS`, entre Ventas y Leads:

```ts
{ href: '/anuncios', label: 'Anuncios' },
```

Nada más de ese archivo. **Es el único archivo compartido con el resto del panel que este task toca**,
y por eso está en la fila de T17 en §8 del plan: para que nadie más lo edite en paralelo.

## 4. `app/(panel)/anuncios/SubNav.tsx`

Las tres sub-pestañas de la sección, con el mismo criterio de preservar el query string que `Nav.tsx`:

```
Campañas   → /anuncios
Reglas     → /anuncios/reglas
Historial  → /anuncios/historial
```

**Lo creás vos con los tres links, aunque dos de esas rutas las escriba T19 después.** Next resuelve
`href` en runtime, así que un link a una ruta que todavía no existe no rompe el build (es exactamente
lo que hizo T05 con `Nav.tsx` mientras T06-T09 estaban a medio hacer). T19 lo importa y no lo toca.

Marcá la activa con `aria-current="page"`, como `Nav.tsx`.

## 5. `app/api/data/ads/route.ts` — la lectura

```
GET /api/data/ads?level=campaign|adset|ad&period=today&account=act_123
                 &status=active|paused|any&nombre=PXN&campaignId=...&adsetId=...
                 &limit=500&after=<objectId>
```

**La respuesta viene ACOTADA desde la primera versión** (`limit` default 500, máximo 1000) y trae `hayMas`.
`getMetricasAds` ya lo soporta (T15 §5 punto 6).

No es optimización prematura: la versión anterior devolvía **el conjunto entero**, y ese conjunto crece con
la cuenta del usuario sin ningún techo. "Hoy hay pocos anuncios" no es una propiedad del sistema, es una
circunstancia, y la tabla de anuncios sólo crece. El cursor es por `objectId` estable y **no por `OFFSET`**,
que además de ponerse lento saltea filas cuando hay inserciones concurrentes.

Cuando `hayMas` es `true`, la UI muestra un botón de "cargar más" y **dice cuántas filas está viendo**. Una
tabla truncada en silencio es peor que una tabla larga: el usuario busca un anuncio, no lo encuentra, y
concluye que no existe.

Copiá la estructura de `app/api/data/sales/route.ts`, que ya tiene todo resuelto:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

if (!isAuthenticated(req.cookies)) return json(401, { ok: false, error: 'unauthorized' });
```

Devuelve `{ ok: true, ...data, adsFreshness }` con `Cache-Control: no-store`.

**Llamá a `ensureFreshAdSpend(range.to, hoy)` de `lib/ads/live.ts`** antes de leer, igual que hace
`/api/data/sales`. Es lo que hace que el gasto de hoy esté al minuto cuando alguien abre la pantalla,
y ya tiene TTL, timeout y promise compartido: **no la modifiques ni la reimplementes**. `adsFreshness`
se muestra en la UI (§6).

Validá `level`, `period` y `status` contra sus listas cerradas y caé al default si vienen mal, en lugar
de devolver 400: es una pantalla, no una API pública, y un query string editado a mano no tiene que
dejarla en blanco. Un `level` inválido → `'campaign'`.

## 6. `AnunciosView.tsx` — la tabla

### Las columnas

| Columna | De dónde sale | Cómo se muestra |
|---|---|---|
| ☐ | selección múltiple | checkbox con `aria-label` propio |
| ESTADO | `status` + `effectiveStatus` | toggle (§7) |
| CAMPAÑA / CONJUNTO / ANUNCIO | `objectName` | link que baja un nivel (§8) |
| PRESUPUESTO | `dailyBudgetEur`, `budgetLevel` | editable en línea, o `—` (§7) |
| ÚLT. ACTUALIZACIÓN | `ultimaAccionAt` | `fmtDateTime`, o `—` |
| VENTAS | `sales` | `fmtInt` |
| CPA | `cpaEur` | `fmtMoney(_, 'EUR')`, `—` si es `null` |
| GASTOS | `spendEur` | `fmtMoney` |
| INGRESOS | `revenueEur` | `fmtMoney` |
| GANANCIA | `profitEur` | `fmtMoney` + tono `good`/`bad` según el signo |
| ROAS | `roas` | 2 decimales, `—` si es `null` |
| ROI | `roi` | 2 decimales, `—` si es `null`, tono por el umbral 1,0 |

**`null` se dibuja como `—`, nunca como `0,00`.** Es la misma regla que T15 §6 y por la misma razón: un
objeto sin gasto no tiene ROI, y mostrar `0,00` hace que el usuario crea que está perdiendo plata
cuando todavía no gastó nada.

**GANANCIA y ROI llevan tooltip.** El panel tiene dos definiciones distintas de "ROI" y hay que
decirlo (D-A7):

> ROI = neto ÷ gasto de ads, con comisiones y costo de producto ya restados.
> ROAS = ingresos brutos ÷ gasto de ads, sin restar nada.
> Ojo: el ROI de la sección Ventas se calcula distinto (sobre el gasto total).

**El color nunca es el único portador de información** (es la regla de accesibilidad del kit): la
ganancia negativa va con el signo `−` visible además del tono `bad`.

### Arriba de la tabla

- Cuatro `StatCard` con los totales del período: gasto, ingresos, ganancia, ROI del conjunto.
- Un `Banner` con las **ventas sin atribuir** (`sinAtribuir` de T15). No se esconde: es plata que entró
  y que la tabla no explica (D-A8). Tono `info` si es poco, `warn` si pasa el 20% de las ventas.
- La frescura del gasto (`adsFreshness`): "gasto actualizado hace 12 s" y, si viene `error`, un
  `Banner` con tono `warn` **al lado de los números, no en lugar de ellos**.
- La zona horaria y el rango resueltos (`rango` de T15): "hoy en `Europe/Lisbon`". Sin esto, el usuario
  compara con Ventas —que corta el día en Buenos Aires— y no entiende la diferencia.

### Los filtros

Nombre (input con debounce), nivel (Campañas / Conjuntos / Anuncios), estado (Cualquiera / Activos /
Pausados), cuenta (select con las de `ad_accounts`) y período. Todos al query string.

## 7. Los dos controles que escriben

Son los que pueden gastar plata desde un click. Las mismas reglas que el motor, aplicadas en la UI.

### El toggle de estado

- Optimista: cambia al instante y **revierte si el POST falla**, con un `Banner` que muestra el error
  de Meta tal cual. Un toggle que se queda en la posición nueva después de fallar es una mentira.
- `disabled` mientras el POST está en vuelo, para que dos clicks no manden dos llamadas.
- **Si `effectiveStatus` no coincide con `status`, mostralo.** Un conjunto `ACTIVE` con
  `effective_status = CAMPAIGN_PAUSED` no entrega: va un `Badge` con tono `warn` que diga "campaña
  pausada". Sin eso, el usuario ve "activo", no gasta, y no hay forma de entender por qué.
- `ARCHIVED`, `DISAPPROVED`, `WITH_ISSUES`, `PENDING_REVIEW` y `IN_PROCESS` **no son toggleables**:
  `Badge` informativo y el toggle deshabilitado con el motivo en el `title`.

### El presupuesto editable

- Solo editable donde el presupuesto **vive en ese nivel**: `budgetLevel === level`. En un conjunto de
  una campaña CBO se muestra el importe de la campaña en gris con un `title` que diga "el presupuesto
  se maneja en la campaña" (D-A5). En los anuncios, siempre `—`: en Meta no tienen presupuesto.
- **Y sólo si `budgetMode === 'daily'`** (D-A10). Con `'lifetime'` se muestra el importe en gris con un
  `title` que diga "presupuesto total: este panel sólo edita presupuestos diarios". El módulo escribe
  `daily_budget` y nada más; mostrarlo editable hace que cada intento falle contra Meta con un error de
  validación que no explica la causa.
- Se escribe en EUR y el endpoint convierte a céntimos. **La UI no hace la conversión**: un solo lugar
  redondea (D-A6).
- **El campo tiene `max` = el techo absoluto** (`ads_max_daily_budget_eur`, D-A9c), que llega en la
  respuesta del endpoint de lectura. Es una ayuda, no la defensa: el servidor rechaza igual, porque el
  route handler se puede invocar directo.
- Confirmación antes de mandar, con el valor viejo y el nuevo en el texto. Es plata.

### Las acciones en lote

Con filas seleccionadas, tres botones: **Pausar**, **Activar**, **Cambiar presupuesto**. Un solo POST
con la lista de ids. El diálogo de confirmación dice **cuántos objetos** y **cuáles** (los primeros 5 y
"y otros N"), porque seleccionar con el checkbox del header y no darse cuenta es fácil.

**El lote no es atómico y hay que decirlo.** Si 3 de 10 fallan, la respuesta trae el detalle por objeto
y la UI muestra "7 de 10 aplicados" con la lista de los que no. Reintentar los 10 volvería a tocar los
7 que ya salieron bien.

## 8. Navegar la jerarquía

Click en el nombre de una campaña → `?level=adset&campaignId=<id>`. Click en un conjunto →
`?level=ad&adsetId=<id>`. Un breadcrumb arriba para volver, con el nombre del padre.

Es lo que hace usable la tabla: se entra por campaña, se ve cuál rinde, se baja a los conjuntos.
`getMetricasAds` ya recibe `campaignId` y `adsetId` (T15 §contrato), así que el filtrado es del server,
no del cliente.

## 9. `app/api/ads/acciones/route.ts` — la escritura manual

```
POST /api/ads/acciones
{ "level": "adset", "action": "pause" | "activate" | "budget",
  "objectIds": ["1201...", "1202..."], "budgetEur": 25.00 }
```

El molde es `app/api/config/ads/route.ts`, que ya tiene el patrón de escritura del proyecto. Ocho
reglas:

1. **`guard(req)` primero**, o `isAuthenticated(req.cookies)` como en `/api/data/*`. El middleware ya
   cubre la ruta, pero es la convención del proyecto y la única defensa si alguien cambia el matcher.
2. **Validación con `zod`**: `schema.safeParse(await req.json().catch(() => null))` → 400
   `{ ok: false, error: 'invalid_payload', detail: issues[0]?.message }`. Igual que el resto de
   `/api/config/*`.
3. **`objectIds` con tope duro** (100). Sin tope, un POST armado a mano puede disparar mil llamadas a
   Meta y quemar la cuota del día.
4. **`budgetEur` se valida contra el TECHO ABSOLUTO, no sólo contra cero** (D-A9c). `> 0` era el único
   límite y no alcanza:

   ```ts
   const { maxDailyBudgetEur, maxDeltaPorTickEur } = await interruptores();
   if (budgetEur > maxDailyBudgetEur) {
     return json(400, { ok: false, error: 'tope_absoluto',
       detail: `€${budgetEur} pasa el máximo de €${maxDailyBudgetEur} por objeto` });
   }
   // Y el agregado del lote: la suma de lo que se va a AGREGAR entre todos los
   // objetos seleccionados, contra ads_max_delta_por_tick_eur.
   ```

   **La confirmación de la UI no es un control de seguridad.** Este route handler se puede invocar directo
   con un `curl` autenticado, y un `budgetEur: 250000` (un decimal mal puesto, un valor ya en céntimos, un
   payload copiado) llegaba a Meta tal cual. El diálogo del §7 protege contra un click distraído; el techo
   protege contra un error de unidades, que es el que cuesta plata de verdad.

   **El tope agregado del lote es el que el tope por objeto no ve:** 80 conjuntos a €50 cada uno son €4.000
   de presupuesto diario nuevo en un request, y cada uno individualmente estaba dentro del límite.

   Y se **rechaza**, no se recorta a `maxDailyBudgetEur`. Un pedido de €250.000 recortado callado a €200
   deja el objeto en un valor razonable y esconde el bug que generó el número.

4b. **La conversión a céntimos es UNA sola** `Math.round(x * 100)`, en el servidor. La UI escribe EUR y no
   convierte nada (D-A6).

4c. **`budgetEur` sólo se acepta si el objeto lo soporta** (D-A10). Después de verificar que existe
   (regla 5), se chequea contra la jerarquía:

   | Caso | Respuesta |
   |---|---|
   | `budget_mode = 'lifetime'` | 400 `presupuesto_lifetime_no_soportado` |
   | la cuenta no factura en EUR | 400 `moneda_no_soportada` |
   | `budget_level` ≠ el nivel del objeto | 400 `sin_presupuesto_en_este_nivel` |

   Los tres son errores que Meta también devolvería, pero con un mensaje que no dice la causa: uno habla de
   validación de presupuesto y el otro parece un problema de permisos. Detectarlos acá ahorra una llamada
   de cuota y produce un error que el usuario puede entender.
5. **Se verifica que el objeto exista en la jerarquía y pertenezca a una cuenta activa** antes de
   llamar a Meta. Un id inventado en el body no puede convertirse en una llamada a la API.
6. **Para `action: 'budget'`, se verifica `budget_level`** contra el nivel del objeto y se devuelve un
   error claro (`'sin_presupuesto_en_este_nivel'`) en lugar de dejar que Meta responda algo ilegible.
7. **Cada acción se registra en `ad_actions` con `source: 'manual'`**, su `explicacion` en castellano,
   `dry_run: false`, el `estado` de la mutación y `actor_hint`. Formato:
   ```
   Manual: se pausó el conjunto «PXN UGC OG» (act_1234567). Estado anterior: ACTIVE.
   ```
   ```
   Manual: presupuesto del conjunto «PXN BIDCAP» (act_1234567) de €10,00 a €25,00.
   ```

   **El vocabulario de `action` es cerrado y compartido con el motor.** Para fijar un importe a mano la
   acción es **`budget_set`**, no `'budget'`: el `CHECK ad_actions_action_valida` acepta
   `pause | activate | budget_increase | budget_decrease | budget_set | config`. Si este endpoint escribe
   `'budget'` y T16 escribe `'budget_increase'` para la misma columna, el filtro del historial no encuentra
   ni la mitad de las filas y nadie se da cuenta hasta que busca algo puntual.

   **Y sobre "quién tocó esto": hay que ser honesto con lo que esta fila responde.** La versión anterior
   decía "el historial responde quién tocó esto, y una persona también es un quién". No alcanza: el panel
   se autentica con una **contraseña compartida** y una cookie HMAC, sin usuarios ni roles ni sesiones
   revocables una por una. `source: 'manual'` dice **por qué canal** entró la acción, no quién la hizo.

   Lo que sí se puede guardar es el rastro técnico de la petición, y para eso está `actor_hint`: IP
   (`x-forwarded-for`), un request id y el user-agent recortado. Es lo máximo que este modelo de
   autenticación permite. **No lo llames identidad**, porque no lo es, y está anotado con esa magnitud en
   P-A12 del plan: agregar identidad individual es un cambio en la autenticación de todo el panel.

8. **La fila se abre ANTES del POST y se cierra después** (§6c del plan), igual que en el motor:

   ```
   abrirAccion({ estado: 'pendiente', before_value, after_value: <lo que se va a pedir> })
     → POST a Meta
     → cerrarAccion({ estado: 'confirmado' | 'fallido' | 'indeterminado' })
   ```

   Si el proceso muere entre el POST aceptado y el `INSERT`, queda un objeto cambiado sin ninguna fila que
   lo diga. Un timeout es `'indeterminado'`, no `'fallido'`: puede haberse aplicado igual.

9. **Después de escribir en Meta, releé el objeto y actualizá la fila de la jerarquía** (`ad_sets.status`,
   `daily_budget`, `synced_at`). Sin eso, la pantalla vuelve al valor viejo en el próximo refresh hasta que
   corra `ads:jerarquia`, y parece que la acción no funcionó.

   Se escribe **lo que Meta devuelve**, no lo que pediste: si ajustó al mínimo de la cuenta o redondeó, el
   valor real es el suyo.

**Los interruptores globales de D-A12 no aplican acá, el TECHO ABSOLUTO sí.** Los interruptores son para el
motor automático; una acción manual es una persona apretando un botón a propósito (D-A12c). Dejalo en un
comentario para que nadie lo "arregle".

Pero el techo de D-A9c **no tiene excepciones y este endpoint es justo el que más lo necesita**, porque es
el único donde un importe entra escrito a mano y donde un payload armado a mano llega directo a Meta.

**`level: 'ad'` con `action: 'budget'` se rechaza en el schema de zod.** En Meta los anuncios no tienen
presupuesto (D-A5). Que el tipo lo haga imposible es más barato que descubrirlo por un error de la API.

## 10. Verificación

Nada de esto es opcional.

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"
# Guardá la cookie del browser primero:
#   printf '%s' '<valor de panel_token>' > /tmp/panel_token
export CK="-b panel_token=$(cat /tmp/panel_token)"

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — SIN COOKIE, LOS DOS ENDPOINTS DAN 401 (§9.5 del plan)
curl -s -o /dev/null -w "data:%{http_code}\n" 'http://localhost:3005/api/data/ads?level=campaign'
curl -s -o /dev/null -w "acciones:%{http_code}\n" -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' -d '{"level":"adset","action":"pause","objectIds":["1"]}'
# esperado exactamente: data:401  y  acciones:401
# Si alguno devuelve datos o 200, es un bug y no una comodidad.

# 3 — con cookie, los tres niveles devuelven filas
for L in campaign adset ad; do
  curl -s $CK "http://localhost:3005/api/data/ads?level=$L&period=today" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('$L','ok=',d['ok'],'filas=',len(d['filas']),'tz=',d['rango']['timezone'])"
done
# esperado: ok=True y filas>0 en los tres. La tz tiene que ser la de la cuenta.

# 4 — el payload inválido se rechaza con 400 y no con 500
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' -d '{"level":"ad","action":"budget","objectIds":["1"],"budgetEur":10}'
# esperado: 400 con error invalid_payload (un anuncio no tiene presupuesto, §9)
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' -d '{"level":"adset","action":"pause","objectIds":[]}'
# esperado: 400
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' -d "{\"level\":\"adset\",\"action\":\"pause\",\"objectIds\":$(python3 -c 'print([str(i) for i in range(200)])' | tr "'" '"')}"
# esperado: 400 — el tope de 100 del §9.3

# 4b — EL TECHO ABSOLUTO CORTA POR EL CAMINO MANUAL (§9.4, D-A9c, criterio 7b del plan)
#      Es el criterio más importante de este endpoint: la confirmación de la UI NO
#      es un control de seguridad, porque esto se puede invocar con un curl.
export AS_OK=$($PSQL -tAc "SELECT adset_id FROM ad_sets WHERE daily_budget IS NOT NULL LIMIT 1")
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_max_daily_budget_eur';"   # esperado: 200
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' \
  -d "{\"level\":\"adset\",\"action\":\"budget_set\",\"objectIds\":[\"$AS_OK\"],\"budgetEur\":250000}"
# esperado: 400 con error 'tope_absoluto' y el importe del techo en el detail.
# NO tiene que aplicar €200 (rechaza, no recorta) y NO tiene que llamar a Meta.
$PSQL -tAc "SELECT count(*) FROM ad_actions WHERE created_at > now() - interval '1 min';"
# esperado: 0 — un pedido rechazado por el techo no genera fila de acción

# 4c — y el tope AGREGADO del lote, que es el que el tope por objeto no ve
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_max_delta_por_tick_eur';"  # esperado: 300
# Armá un lote de objetos cuyo delta total pase €300 estando cada uno bajo €200:
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' \
  -d "{\"level\":\"adset\",\"action\":\"budget_set\",\"objectIds\":$($PSQL -tAc "SELECT json_agg(adset_id) FROM (SELECT adset_id FROM ad_sets WHERE daily_budget IS NOT NULL LIMIT 8) t"),\"budgetEur\":150}"
# esperado: 400 con 'tope_absoluto' mencionando el agregado.
# 8 conjuntos a €150 son €1.200 de presupuesto diario nuevo en un request, y cada
# uno individualmente estaba dentro del límite.

# 4d — un objeto con presupuesto TOTAL se rechaza con un error que dice por qué (§9.4c)
export AS_LT=$($PSQL -tAc "SELECT adset_id FROM ad_sets WHERE lifetime_budget IS NOT NULL LIMIT 1")
[ -n "$AS_LT" ] && curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' \
  -d "{\"level\":\"adset\",\"action\":\"budget_set\",\"objectIds\":[\"$AS_LT\"],\"budgetEur\":25}" \
  || echo "no hay conjuntos con presupuesto total: anotalo y salteá esta verificación"
# esperado: 400 'presupuesto_lifetime_no_soportado'. NO un error de Meta sobre
# validación de presupuesto, que no dice la causa y gasta una llamada de cuota.

# 5 — un id que no existe no se convierte en una llamada a Meta (§9.5)
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' \
  -d '{"level":"adset","action":"pause","objectIds":["999999999999999"]}'
# esperado: error de objeto desconocido, NO un error de Meta

# 6 — LA ACCIÓN MANUAL FUNCIONA DE VERDAD, sobre un conjunto YA PAUSADO
#     (pausar algo pausado no cambia nada y prueba el camino completo)
export AS_ID=$($PSQL -tAc "SELECT adset_id FROM ad_sets WHERE status='PAUSED' LIMIT 1")
curl -s $CK -X POST 'http://localhost:3005/api/ads/acciones' \
  -H 'content-type: application/json' \
  -d "{\"level\":\"adset\",\"action\":\"pause\",\"objectIds\":[\"$AS_ID\"]}"
# esperado: ok con el detalle por objeto

# 7 — y quedó en el historial con source='manual', estado y actor_hint (§9.7)
$PSQL -c "SELECT source, action, estado, dry_run, ok, actor_hint, explicacion
            FROM ad_actions WHERE source='manual' ORDER BY id DESC LIMIT 3;" -P expanded=on
# esperado: source=manual, estado=confirmado, dry_run=f, actor_hint NO nulo, y una
# FRASE en castellano. Leela de verdad: si dice 'undefined' o un motivo en inglés,
# arreglala.
#
# Y el `action` tiene que ser del vocabulario cerrado: 'budget_set' para fijar un
# importe a mano, NO 'budget'. Si escribís 'budget', el CHECK
# ad_actions_action_valida lo rechaza con un 500 y el historial de T19 no lo
# encuentra en ningún filtro.

# 7b — la paginación del endpoint de lectura funciona y avisa (§5)
curl -s $CK 'http://localhost:3005/api/data/ads?level=ad&period=today&limit=2' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("filas:",len(d["filas"]),"hayMas:",d["hayMas"])'
# esperado: exactamente 2 filas, y hayMas=true si hay más de 2 anuncios.
# Pedí la página siguiente con after=<el objectId de la última fila> y verificá
# que no repite ni saltea. Una tabla truncada EN SILENCIO es peor que una larga:
# el usuario busca un anuncio, no lo encuentra, y concluye que no existe.

# 8 — la pestaña está en el Nav y las tres sub-pestañas también
grep -n "anuncios" components/Nav.tsx
grep -c "href" app/\(panel\)/anuncios/SubNav.tsx    # esperado: al menos 3

# 9 — REVISALA EN EL BROWSER. Esto no se verifica con curl:
#   · un objeto con gasto 0 muestra — en ROI/ROAS/CPA, no 0,00
#   · una campaña ACTIVE con effective_status CAMPAIGN_PAUSED muestra el badge
#   · el presupuesto de un conjunto de campaña CBO NO es editable
#   · el presupuesto de un objeto con budgetMode 'lifetime' NO es editable, y el
#     title explica que el panel sólo edita presupuestos diarios (D-A10)
#   · el campo de presupuesto tiene max = el techo absoluto, y escribir más lo marca
#   · el presupuesto de un anuncio es siempre —
#   · con más filas que el limit, aparece el "cargar más" y se ve cuántas se están
#     mostrando (una tabla truncada en silencio manda a buscar un anuncio que sí existe)
#   · el banner de ventas sin atribuir aparece y dice cuántas
#   · se ve la zona horaria del rango
#   · el toggle revierte si el POST falla (probalo cortando la red un segundo)
#   · click en una campaña baja a sus conjuntos y el breadcrumb vuelve
#   · con el teclado solo: se puede llegar al toggle y activarlo (foco visible)

# 10 — no se tocó nada de lo existente
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort

# 11 — limpieza: dejá los topes como estaban
$PSQL -c "UPDATE settings SET value='200'::jsonb WHERE key='ads_max_daily_budget_eur';"
$PSQL -c "UPDATE settings SET value='300'::jsonb WHERE key='ads_max_delta_por_tick_eur';"
```

## 11. Cuándo parar

**Bloqueante, pará y avisá:**

- La verificación 2 no da 401 en los dos endpoints.
- La verificación 5 llega a Meta con un id inventado. Es un endpoint autenticado, pero igual: no se le
  pasan ids del body a la API sin validarlos contra la base.
- **La verificación 4b muestra que un `budgetEur: 250000` llega a Meta, o que se recorta en silencio a
  €200.** Es el único freno que protege contra un decimal mal puesto, un valor ya en céntimos o un payload
  copiado, y la confirmación de la UI no cuenta porque este endpoint se invoca con un `curl`.
- El toggle deja el estado nuevo en la pantalla después de que el POST falló. Es la clase de bug que
  hace que el usuario crea que pausó algo que sigue gastando.
- **El `find` de la verificación 10 lista un archivo fuera de tu fila** (`components/ui.tsx`,
  `lib/queries/ads.ts`, o cualquiera de otra task). Ojo: `git diff` no te va a avisar, porque
  `dashboard-admin` no está trackeado y el diff sale vacío. Hay que leer la lista del `find`.

**Anotalo en §10 del plan y seguí:**

- Necesitás una columna que `MetricasObjeto` no tiene. **No modifiques `lib/ads/tipos.ts`:** anotalo.
- `getMetricasAds` no filtra por algo que la UI necesita (por ejemplo el `nameFilterMode`). Filtrá en el
  cliente por ahora y anotalo para T15.
- Todos los `effective_status` coinciden con `status` en tus datos, así que no podés probar el badge del
  §7. Anotalo y dejá el código igual: T14 ya verificó que el campo se guarda.
- La tabla queda lenta con muchos anuncios. Anotá cuántas filas y cuánto tarda; la paginación no está en
  el alcance de este task.
