# T02 — Métricas nuevas en las queries de Resumen y Ventas

- **Depende de:** T01 (terminada y compilando).
- **Bloquea:** T05 y T06 (sus catálogos de widgets consumen estos campos).
- **Paralelizable con:** T03 y T04. Ninguno de los tres se toca los archivos.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `lib/queries/overview.ts`, `lib/queries/sales.ts`,
  `lib/queries/overview.test.ts`, `lib/queries/sales.test.ts`. **Nada más.**

Leé `00-PLAN-REDISENO.md` completo. Este task es el que le da datos a los widgets, así que un campo
mal nombrado o con la unidad equivocada se propaga a T05 y T06.

---

## 1. Objetivo

Agregar a `OverviewData` y a `SalesTotals` las métricas que hoy **no existen** y exponer las que **ya
se calculan y nadie muestra**. Sin SQL nuevo: todo sale de campos que las queries ya traen.

**Este task no toca ninguna pantalla.** No abre `app/(panel)/`. Los campos quedan en el JSON y T05 y
T06 los muestran. Si te encontrás editando un `.tsx`, estás en el archivo equivocado.

**Tampoco toca los routes.** `app/api/data/overview/route.ts` y `sales/route.ts` devuelven el objeto
entero, así que un campo nuevo viaja solo (§8 del plan).

## 2. Dos convenciones que ya existen en el proyecto y que hay que respetar

Esto es lo primero que hay que entender, porque equivocarse acá da un número 100 veces más grande en
pantalla y nadie lo va a notar hasta que sea tarde.

### 2.1 Los ratios van en tanto por uno, y `fmtPct` NO multiplica

`fmtPct(n)` en `components/ui.tsx` formatea el número **tal como llega**: `fmtPct(12.3)` da
`"12,3 %"`. No multiplica por 100.

Y las queries devuelven los ratios en **tanto por uno**:

```ts
roas: adSpendEur > 0 ? grossEur / adSpendEur : 0,          // 1.196
convSessionToSale: sessions > 0 ? orders / sessions : 0,   // 0.0139
roi: spendTotalOrig > 0 ? (...) / spendTotalOrig : 0,      // 0.035 = 3,5%
```

Así que las vistas hacen `fmtPct(x * 100)`. **Los campos nuevos siguen esa convención: tanto por
uno.** La multiplicación es de la vista.

**La excepción, que NO se toca:** `upsellTakeRate()` en `sales.ts` devuelve **0-100** (hace
`(upsell / front) * 100`) y hay un test que lo lockea. Es la única función con esa unidad. Dejala
como está y **no la uses de modelo**: en su lugar, agregale un comentario que diga que devuelve
0-100 al contrario del resto, porque es exactamente la clase de detalle que produce un widget con
un `*100` de más.

**En cada campo nuevo, escribí la unidad en el comentario.** No "el porcentaje de devoluciones", sino
"tanto por uno: 0,035 = 3,5 %".

### 2.2 Los campos nuevos devuelven `null` sin denominador; los viejos siguen devolviendo 0

Las queries de hoy devuelven **0** cuando el denominador es 0, con este comentario repetido:

```ts
// Sin sesiones no hay denominador: 0, no NaN en el JSON (test 2).
```

Evitar `NaN` está bien, pero **0 es una respuesta falsa**: "el ROAS es 0" y "no hay gasto cargado, no
se puede calcular el ROAS" son dos cosas distintas, y en un panel la diferencia importa. Un ROAS en 0
se lee como una campaña que no vende.

**Los campos nuevos de este task devuelven `number | null`**, con `null` = "no se puede calcular".

**Y los viejos se quedan en 0.** No es una inconsistencia por descuido, es la única opción viable y
conviene entender por qué: cambiar `roas` a `number | null` cambia el tipo que consumen
`ResumenView` y `VentasView`, que son de T05 y T06. `tsc` fallaría en archivos que **este task no
puede tocar** (§8 del plan), así que T02 no compilaría. Además rompería tests existentes y podría
mover un número en pantalla, que es lo que §9.4 del plan prohíbe.

Dejalo anotado en el archivo, arriba de los campos nuevos:

```ts
// Los campos de esta sección devuelven null cuando no hay denominador, no 0:
// "no se puede calcular" y "vale cero" son cosas distintas. Los campos de
// arriba (roas, convSessionToSale, cpa, roi) devuelven 0 por compatibilidad
// con las vistas y los tests que ya existen — no unificar sin cambiar las dos
// vistas a la vez.
```

**Cómo se muestra un `null`:** `fmtPct` y `fmtMoney` ya devuelven `'—'` para cualquier valor no
finito, así que el idioma en los catálogos de T05/T06 es `fmtPct((x ?? NaN) * 100)`. No hace falta un
formateador nuevo ni un primitivo nuevo en `ui.tsx`.

## 3. `lib/queries/overview.ts`

### 3.1 En `FunnelSummary` (por funnel)

Todos derivables de campos que la query ya trae. **Cero SQL nuevo.**

| Campo | Fórmula | Por qué sirve |
|---|---|---|
| `refundRate` | `ordersRefunded / orders` | La tasa de devolución no existe en ningún lado del panel |
| `netMargin` | `netEur / grossEur` | Cuánto del bruto sobrevive a devoluciones, comisiones y costos |
| `convCheckoutToSale` | `orders / checkoutClicks` | El paso final del embudo: cuántos de los que clickean compran |
| `convSessionToQuiz` | `quizStarted / sessions` | Cuántos arrancan el quiz |
| `convQuizToSalesView` | `salesViews / quizStarted` | Del quiz a la página de venta |
| `revPerSession` | `netEur / sessions` | Ingreso por sesión, en EUR. Es la métrica que junta tráfico y plata |
| `cpa` | `adSpendEur / orders` | El CPA existe en `sales.ts` y **falta en overview**: no se puede comparar el CPA de dos funnels |

`netMargin` puede dar negativo (si las devoluciones y los costos superan al bruto) y así se devuelve.
No lo acotes a 0: un margen negativo es información.

Cuidado con `netMargin`: el denominador es `grossEur`, que **puede ser 0 con `netEur` distinto de 0**
(un rango con una devolución de una venta de otro mes). Ahí devolvés `null`, no `-Infinity`.

### 3.2 En `totals`

Faltan dos cosas: los ratios del conjunto, y **campos que ya se calculan y no se exponen**.

```ts
/** El bruto sumado de todos los funnels. YA se calcula (variable `brutoTotal`,
 *  el numerador del roas de totals) y no se expone: hoy el panel muestra un
 *  ROAS sin poder mostrar de dónde sale. */
grossEur: number;

/** Sumas que existen por funnel y no en el total. Un widget de Resumen que
 *  quiera "clicks al checkout" hoy tiene que sumarlas en el componente. */
quizStarted: number;
salesViews: number;
checkoutClicks: number;

/** Los mismos ratios del §3.1, a nivel total. null sin denominador. */
refundRate: number | null;
netMargin: number | null;
convSessionToSale: number | null;
convCheckoutToSale: number | null;
revPerSession: number | null;
cpa: number | null;
```

**Los ratios del total se calculan con los totales, no promediando los de cada funnel.** Ya hay un
comentario en el archivo que lo explica para el ROAS y aplica igual acá: el promedio de dos ratios no
es el ratio del conjunto. Un funnel con 1 venta y otro con 1.000 no pesan lo mismo.

`convSessionToSale` en `totals` es nuevo (existe por funnel). Como es nuevo, **va con la convención
nueva**: `null` sin sesiones. Que el de `FunnelSummary` devuelva 0 y el de `totals` devuelva `null`
es raro de ver, pero es lo que §2.2 explica: no se puede cambiar el viejo.

### 3.3 `PrevTotals`

`prev` sirve para el trend de las StatCards y hoy trae 4 campos. Agregale **sólo** lo que un widget
vaya a comparar contra el período anterior:

```ts
adSpendEur: number;
resultEur: number;
```

Sin esto, un widget de "Resultado" no puede mostrar si mejoró. Y `computePrev` ya corre
`SUMMARY_SQL`, que trae `adSpendEur`: son dos líneas, no una query más.

**No le agregues los ratios a `prev`.** El trend de un ratio (¿"el margen subió 3 puntos" o "subió un
3 %"?) es ambiguo y nadie lo pidió: va a §10 del plan si hace falta.

## 4. `lib/queries/sales.ts`

En `SalesTotals`. Ojo con qué campos existen acá: **`sales.ts` no tiene `sessions` ni
`checkoutClicks`**, así que `revPerSession` y `convCheckoutToSale` **no van** en esta pantalla. Son de
Resumen. No los inventes con otra fórmula.

| Campo | Fórmula | Nota |
|---|---|---|
| `refundRate` | `(ordersRefunded + ordersChargeback) / (ordersApproved + ordersRefunded + ordersChargeback)` | Ver abajo |
| `netMargin` | `netEur / grossEur` | Tanto por uno |
| `avgTicketOrig` | `netOrig / ordersApproved` | Ver abajo |
| `commissionRate` | `commissionsEur / grossEur` | Cuánto se lleva la pasarela |
| `costRate` | `costsEur / grossEur` | Cuánto pesa el costo del producto |

**`refundRate`: el denominador es una decisión, escribila en el comentario.** El enum de `status`
tiene cuatro valores y `'pending'` es uno de ellos. Una orden pendiente **no entra en ninguno de los
dos lados**: nunca fue una venta, así que ni suma al numerador ni al denominador. Y los chargebacks
**sí** entran en el numerador: para el negocio es plata que volvió, igual que una devolución. Dejalo
escrito así en el código, porque es la clase de número que alguien va a querer auditar:

```ts
/**
 * Tanto por uno: 0,04 = 4 %. Devoluciones + chargebacks sobre las órdenes que
 * alguna vez fueron una venta. Las 'pending' quedan fuera de los dos lados:
 * no son ni una venta ni una devolución.
 */
refundRate: number | null;
```

**`avgTicketOrig` es un agujero real, no un extra.** `SalesTotals` tiene `avgTicketEur` y nada más,
pero la pantalla tiene un toggle EUR/ARS: en vista ARS, el ticket promedio se muestra **en euros con
el símbolo de peso** o hay que recalcularlo en el componente. Todos los demás importes vienen en las
dos monedas (`netOrig`/`netEur`, `cpa`/`cpaEur`, `roas`/`roasEur`). Este quedó sin par.

`avgTicketOrig` es nuevo, así que devuelve `null` sin órdenes aprobadas, mientras `avgTicketEur` sigue
en 0. Otra vez §2.2.

## 5. Los tests

Los tests de estos dos archivos existen y **pasan sin `DATABASE_URL`** salteándose los que necesitan
base (262 con base, 208 + 54 salteados sin ella). Respetá ese patrón: mirá cómo los archivos actuales
deciden saltear y hacé lo mismo.

**Los que no son opcionales:**

1. **Denominador en 0 devuelve `null`, no 0, no `NaN`, no `Infinity`.** Uno por cada campo nuevo.
   Es el test que protege la decisión de §2.2, y es el que va a fallar si alguien "arregla" un `null`
   con un `?? 0`.
2. **`JSON.stringify` del resultado no contiene `NaN` ni `null` donde debería haber número.**
   `JSON.stringify(NaN)` da `null`, así que un `NaN` filtrado se disfraza de "no se puede calcular" y
   es indistinguible en la red. El test tiene que mirar el objeto, no el JSON.
3. **Los campos viejos NO cambiaron.** `roas`, `convSessionToSale`, `avgTicketEur`, `cpa`, `roi`
   siguen devolviendo **0** sin denominador. Es el test que impide que alguien unifique las dos
   convenciones y rompa las vistas de T05/T06.
4. **`netMargin` con `grossEur = 0` y `netEur ≠ 0`** devuelve `null`. El caso raro del §3.1.
5. **`refundRate` ignora las `'pending'`** en los dos lados de la división.
6. **Los ratios de `totals` no son el promedio de los de cada funnel.** Armá dos funnels muy
   desbalanceados (uno con 1 venta, otro con 1.000) y verificá que el total sigue al grande. Si
   alguien refactoriza a `funnels.reduce(...)/funnels.length`, este test lo atrapa.

**No agregues tests de UI.** No hay `@testing-library` y no se instala (§0 del plan).

## 6. Lo que NO se hace

De P-R01 del plan: el usuario dijo "sí esas y agregá algunas que no existan" **sin dar una lista**. Se
implementa sólo lo **derivable de lo que las queries ya devuelven**, que es todo lo de §3 y §4.

**No se hace, y no se empieza a hacer:**

- **Cohortes y LTV.** Requieren agrupar por primera compra del email: SQL nuevo, probablemente índice
  nuevo, y una definición de cohorte que nadie dio.
- **Comparación contra el mismo día de la semana anterior.** `prev` compara contra el período
  inmediatamente anterior de igual largo. Un "mismo martes del mes pasado" es otra query.
- **Proyección de fin de mes, tendencias, medias móviles.** Nada que invente un número que no está
  en la base.
- **Métricas de `ad_spend` por conjunto o anuncio.** Eso es `lib/queries/ads.ts`, que este task **no
  puede tocar** (§8 del plan) y que ya tiene su propia pantalla.

Al terminar, **dejá en §10 del plan la lista de lo que implementaste** para que el usuario tache lo
que no quiere y pida lo que falta. Es una lista de nombres, no un párrafo.

## 7. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila y los tests suben, no bajan
npx tsc --noEmit && npm run build && npm test
# esperado: tsc y build en 0. El total de tests tiene que SUBIR (agregaste los
# de §5). Si bajó, rompiste uno existente.

# 2 — LAS VISTAS SIGUEN COMPILANDO SIN TOCARLAS.
#     Es el criterio que prueba que respetaste §2.2: si hubieras cambiado un
#     campo viejo a `number | null`, tsc fallaría en ResumenView o VentasView,
#     que son de T05 y T06.
npx tsc --noEmit && echo "OK: las vistas siguen compilando"

# 3 — los campos nuevos VIAJAN por la red (los routes no se tocaron)
npm run dev
curl -s 'http://localhost:3005/api/data/overview?range=30d' -b "panel_token=$(grep PANEL_PASSWORD .env | cut -d= -f2)" \
  | python3 -m json.tool | grep -E "refundRate|netMargin|revPerSession|grossEur|checkoutClicks|cpa"
# esperado: los campos aparecen en el JSON. Si no están, el route filtra
# campos y hay que avisar (no arreglarlo: el route no es de este task).

# 4 — LA UNIDAD ES LA CORRECTA. El error de 100x.
#     En el JSON de arriba, un ratio de conversión tiene que estar en tanto por
#     uno: convCheckoutToSale de un funnel real ronda 0,28, NO 28.
#     Si ves 28, multiplicaste de más y T05/T06 van a mostrar 2800 %.

# 5 — LOS NÚMEROS QUE YA SE MOSTRABAN NO CAMBIARON (§9.4 del plan).
#     Abrí /resumen y /ventas con un rango cerrado (ej. 30d) y compará el neto
#     total, las órdenes y el gasto de ads contra lo que mostraban antes de
#     esta task. Tienen que ser IDÉNTICOS: este task sólo agrega campos.
#     Un número que se movió es un bug de cálculo, no un efecto del rediseño.

# 6 — null y no 0 cuando no hay denominador
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT count(*) FROM ad_spend;"
# Si da 0 filas en local: en el JSON de /api/data/overview, `cpa` y `roas`
# de cada funnel tienen que ser null (cpa, nuevo) y 0 (roas, viejo).
# Esa diferencia EN EL MISMO OBJETO es exactamente lo que §2.2 decidió.

# 7 — no se tocó nada fuera de la fila T02 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# `git diff` no sirve: dashboard-admin no está trackeado (§9 del plan).
# esperado: SÓLO lib/queries/overview.ts, lib/queries/sales.ts y sus 2 tests.
```

## 8. Cuándo parar

**Bloqueante, pará y avisá:**

- **Una métrica que querés agregar necesita SQL nuevo.** Anotala en §10 del plan y no la hagas. El
  alcance de este task es "derivable de lo que ya viene" y estirarlo mete un escaneo de tabla que
  nadie midió.
- **Un número que ya se mostraba cambió** (verificación 5). Pará: es un bug de cálculo y hay que
  entenderlo antes de seguir.
- **Los tests existentes bajaron de cantidad o alguno falla.**

**Anotalo en §10 del plan y seguí:**

- Se te ocurre una métrica derivable que no está en §3 ni §4. Anotala con la fórmula: **agregarla
  ahora** significa que T05 y T06 no van a saber que existe, porque leen esta lista.
- Un campo que necesitás no está en la query (por ejemplo `sessions` en `sales.ts`). No lo traigas
  con SQL nuevo: anotá qué widget lo quería.
- Encontrás otra inconsistencia de unidades o de `null`/`0` además de las dos de §2. Anotala: son las
  que producen widgets con números 100 veces más grandes y conviene tenerlas todas en un lugar.
