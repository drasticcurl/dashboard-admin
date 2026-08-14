# T04 — Embudo literal por etapas configurables

- **Depende de:** T01 (terminada y compilando).
- **Bloquea:** nada.
- **Paralelizable con:** T02 y T03.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `lib/queries/funnel.ts`, `lib/queries/funnel.test.ts`, `components/EmbudoChart.tsx`,
  `app/(panel)/embudo/**`, `app/api/data/funnel/route.ts`. **Nada más.**

Leé `00-PLAN-REDISENO.md` completo, en especial **§5 (el contrato `EmbudoEtapa`, congelado)**, **D-R07**
(por qué las etapas van en tabla aparte y por slug), **D-R08** (las 8 etapas) y **D-R09 (el embudo no
es monótono, y está medido)**.

---

## 1. Objetivo

Lo que el usuario pidió con estas palabras: *"la parte de embudo tiene que tener una gráfica de un
embudo por partes literalmente"*, y después: *"por partes me refiero un embudo más las partes
mostrando qué porcentaje llega... landing preguntas contenido diagnóstico venta vio la venta clickeó
compró"*.

Entonces:

- **la gráfica de embudo de verdad** (trapecios que se angostan), con 8 partes, hecha con recharts;
- **las etapas salen de `funnel_stages`**, la tabla que la migración 017 creó y sembró, así que son
  **configurables por funnel** (el usuario: *"tiene que ser individual por funnel"*);
- **la lista paso a paso se queda.** No se reemplaza: con 22 y 27 pasos, es la única vista que sirve
  para encontrar el paso exacto donde se cae la gente. El embudo por etapas es la vista de arriba, la
  lista es la de detalle. Las dos, en la misma pantalla.

## 2. Lo primero: el embudo NO es monótono, y está medido

Antes de escribir una línea, entendé esto, porque si no lo tenés en cuenta el gráfico va a mostrar un
trapecio que se ensancha y va a parecer un bug.

Medido en producción, `chauhinchazon`, últimos 30 días:

```
Landing            4011
Preguntas          1086
Puente al experto  1027
Diagnóstico         880
Página de venta     820   ← del histograma de max_step_index
Vio la venta        821   ← de sessions.sales_view_at: UNA MÁS
Clickeó comprar     199
Compró               56
```

**"Vio la venta" tiene más sesiones que "Página de venta".** No es un dato corrupto: los pasos salen
del histograma de `max_step_index` y los hitos salen de columnas propias (`sales_view_at`,
`checkout_click_at`, `purchased_at`). Son dos fuentes que se escriben en momentos distintos, y una
sesión puede tener `sales_view_at` sin haber registrado que alcanzó el paso 21.

**Cómo se resuelve (D-R09):** dos campos separados.

- **`sessions` y `pctOfBase` son el número real.** No se tocan. 821 es 821.
- **`anchoDibujo` es el ancho del trapecio**, recortado al de la etapa anterior cuando el número la
  supera. Es lo que mantiene la figura de embudo.
- **`inconsistente: true`** en esa etapa, y **la UI lo muestra** con una marca visible y el motivo en
  un `title`.

Recortar el número escondería el dato. Ensanchar el trapecio parecería un bug del gráfico. Mostrar el
número real con el dibujo recortado y una marca es lo único honesto.

**El test del §6 punto 1 es obligatorio y usa exactamente estos números.**

## 3. Las unidades: `funnel.ts` usa 0-100, y así se queda

`FunnelStepRow` ya devuelve los porcentajes **multiplicados**:

```ts
const pctOfBase = (sessions / baseRef) * 100;          // 82.5, no 0.825
dropFromPrevious: prev > 0 ? 100 - pctOfPrevious : 0;  // en puntos
```

`EmbudoEtapa` (§5 del plan) sigue **la misma convención**: `pctOfBase`, `pctOfPrevious`,
`dropFromPrevious` y `anchoDibujo` van en **0-100**. Y `fmtPct` no multiplica, así que la vista hace
`fmtPct(etapa.pctOfBase)` sin `*100`.

**Ojo si venís de leer T02:** `overview.ts` y `sales.ts` usan tanto por uno (0-1). `funnel.ts` usa
0-100. Es una inconsistencia real del proyecto, pero **cada archivo es consistente con él mismo**, y
unificarlo movería números en pantalla, que es lo que §9.4 del plan prohíbe. **No la arregles acá**:
si te molesta, anotala en §10 del plan.

## 4. `lib/queries/funnel.ts`

### 4.1 Leer las etapas

Query nueva sobre `funnel_stages` filtrando por `funnel_id`, ordenada por `stage_order`. Las columnas
y los CHECK están documentados en `_schema-017.sql`: leelo, es el contrato.

Cada fila es **o** un rango de pasos (`starts_at_slug`) **o** un hito (`milestone`), nunca las dos y
nunca ninguna: los CHECK de la 017 lo garantizan, así que no hace falta defenderse de eso en TS.

### 4.2 Armar las etapas de paso

**La frontera es el `starts_at_slug` de la etapa siguiente.** Una etapa contiene los pasos desde su
`starts_at_slug` (inclusive) hasta el `starts_at_slug` de la próxima etapa de paso (exclusive). La
última etapa de paso llega hasta el final de los pasos.

**El conteo de la etapa es el de su ÚLTIMO paso** (D-R08). Una etapa se completó cuando la sesión la
atravesó entera. Si tomaras el primero, la etapa nunca caería contra la anterior y el embudo tendría
escalones planos.

Como `steps[i].sessions` ya es "llegaron a este paso o más allá" (suma acumulada inversa, ya
implementada), el conteo de la etapa es directamente `sessions` de su último paso. **No sumes los
pasos**: sumar conteos acumulados da un número sin sentido, varias veces más grande que el total de
sesiones.

### 4.3 Las etapas de hito

`milestone` es un vocabulario cerrado de tres valores (CHECK en la 017) y cada uno mapea a un campo
que `FunnelData` **ya tiene**:

| `milestone` | Campo de `FunnelData` |
|---|---|
| `sales_view` | `salesViews` |
| `checkout_click` | `checkoutClicks` |
| `purchase` | `purchases` |

**No escribas SQL nuevo para los hitos.** Ya se consultan.

### 4.4 Huérfanas

Una etapa cuyo `starts_at_slug` no existe en los pasos del funnel va a `huerfanas`, **no al array de
etapas**. Pasa cuando alguien renombra un slug en el quiz (D-R07: es el caso detectable que motivó
usar slug y no `step_index`).

**Y se muestran en la UI.** Una etapa que desaparece del gráfico sin decir nada es peor que un
error: el usuario ve un embudo de 7 partes y cree que así es.

`_verificacion-017.sql` §6 chequea esto contra la base.

### 4.5 `anchoDibujo`

```
anchoDibujo[0] = 100
anchoDibujo[i] = min(pctOfBase[i], anchoDibujo[i-1])
inconsistente[i] = sessions[i] > sessions[i-1]
```

El recorte es **acumulativo**: se compara contra el `anchoDibujo` de la anterior, no contra su
`pctOfBase`. Si no, dos etapas que crecen seguidas rompen la figura igual.

`inconsistente` se decide con `sessions`, no con el ancho: es una afirmación sobre los datos, no sobre
el dibujo.

### 4.6 Dónde entra en `FunnelData`

Un campo nuevo, `porEtapas: EmbudoPorEtapas`. **No toques los campos que ya están** (`totalSessions`,
`quizStarted`, `salesViews`, `checkoutClicks`, `purchases`, `steps`, `campaigns`, `variants`,
`countries`, `devices`, `ingestWarnings`): la vista los usa y §9.4 del plan dice que los números no se
mueven.

**Un funnel sin etapas configuradas devuelve `etapas: []`.** La UI muestra la lista paso a paso sola,
más un aviso de que no hay etapas configuradas y un link a Config. **No inventes etapas por defecto en
el código**: el seed de la 017 es el único lugar donde se decide eso, y un funnel nuevo sin etapas es
un estado legítimo.

## 5. `components/EmbudoChart.tsx` y la pantalla

### El gráfico, con recharts

`FunnelChart`, `Funnel`, `LabelList` y `Trapezoid` **ya existen** en `recharts 2.15.4` (verificado en
el paquete instalado). **Cero dependencias nuevas** (D-R06).

- El `value` de cada dato es **`anchoDibujo`**, no `sessions`: es lo que dibuja el ancho.
- La etiqueta muestra **`sessions` y `pctOfBase`**, que son los números reales.
- El tooltip agrega `pctOfPrevious` y `dropFromPrevious`: la caída contra la anterior es lo que
  decide dónde está el problema.
- Los colores salen de los tokens de T01, **no** de literales como `#10b981`. Esa es media razón de
  ser de D-R13.
- Las etapas de hito se distinguen visualmente de las de paso (`fuente: 'paso' | 'hito'`): no salen de
  la misma fuente de datos y el usuario tiene que poder verlo.
- Una etapa con `inconsistente: true` lleva **marca visible** y el motivo en el `title`.

**Un `ChartFrame` envuelve el gráfico** (T01 lo creó). No escribas otro `ResponsiveContainer` ni otro
Tooltip a mano: eso es lo que hoy está duplicado en `ResumenView` y `VentasView` y lo que T01 vino a
centralizar.

### La pantalla

El embudo por etapas arriba, **la lista paso a paso abajo**, que se queda como está.

Lo que la pantalla hace hoy y **tiene que seguir haciendo** (§9.5 del plan). Listalo y verificalo uno
por uno:

- el selector de funnel y el `RangePicker`;
- el toggle de base (`landing` / `start`), que es el `BaseMode` de `FunnelFilters`;
- los filtros de variante, campaña, fuente y país;
- las tablas de campañas, variantes, países y dispositivos;
- el banner de `ingestWarnings`;
- el resaltado del peor paso por `dropFromPrevious`.

**`?base=` va al query string** (D-R14). Hoy vive en `useState` y no sobrevive a un refresh. `range` y
`f` ya funcionan así: copiá ese patrón, no inventes otro.

## 6. Los tests — `lib/queries/funnel.test.ts`

Poné la lógica de armado de etapas en una **función pura exportada** que tome los pasos, las filas de
`funnel_stages` y los hitos, y devuelva `EmbudoPorEtapas`. Sin eso, no se puede probar sin base, y
este es el cálculo que más se puede equivocar en silencio.

Respetá el patrón de salteo que ya usa el archivo (262 tests con `DATABASE_URL`, 208 + 54 salteados
sin ella).

No opcionales:

1. **EL CASO 820 → 821** (D-R09). Con los ocho números del §2:
   - `sessions` de "Vio la venta" es **821**, no 820: el número real no se toca;
   - `anchoDibujo` de "Vio la venta" es **igual al de "Página de venta"**, no mayor;
   - `inconsistente` es **true** en "Vio la venta" y **false** en las otras siete.
   Este test es el que impide que alguien "arregle" la no monotonía recortando el número.
2. **El recorte es acumulativo:** tres etapas 100 → 50 → 60 dan anchos 100 → 50 → **50**.
3. **El conteo de una etapa es el de su último paso**, no el del primero ni la suma (§4.2). Armá una
   etapa de 3 pasos con conteos 100/90/80 y esperá **80**.
4. **Una etapa huérfana va a `huerfanas` y no a `etapas`**, y las demás se calculan igual.
5. **Sin etapas configuradas** devuelve `etapas: []` y no tira.
6. **Los hitos leen el campo correcto:** `sales_view`→`salesViews`, `checkout_click`→`checkoutClicks`,
   `purchase`→`purchases`. Con tres valores distintos, para que un mapeo cruzado se vea.
7. **`pctOfPrevious` y `dropFromPrevious` de la primera etapa** son 100 y 0 (§5 del plan), no `NaN` ni
   `Infinity`.
8. **Base en 0**: un funnel sin sesiones no produce `NaN` ni `Infinity` en ningún campo. El archivo ya
   usa `|| 1` para esto en `baseRef`: mirá cómo lo hace y seguí el mismo criterio.
9. **Las unidades son 0-100** (§3): un `pctOfBase` de 0,825 en un test es la señal de que te fuiste a
   tanto por uno.

## 7. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila y los tests suben
npx tsc --noEmit && npm run build && npm test

# 2 — las etapas existen en la base (la 017 de T01)
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT f.slug, st.stage_order, st.label, st.starts_at_slug, st.milestone
     FROM funnel_stages st JOIN funnels f ON f.id=st.funnel_id
    ORDER BY f.slug, st.stage_order;"
# esperado: 8 filas por funnel, stage_order 0..7 sin huecos, 5 con
# starts_at_slug y 3 con milestone. Si están vacías, T01 no terminó bien.

# 3 — la verificación SQL del embudo, y HAY QUE LEER LA SALIDA
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
# Los bloques §5, §6, §7 y §8 son los del embudo. §7 tiene que dar 0 pasos sin
# etapa en los DOS funnels, y §8 dice dónde está la frontera no monótona.
# Sólo 1, 2, 3, 4 y 10 tiran excepción: los otros IMPRIMEN y hay que comparar.

# 4 — EL NÚMERO REAL VIAJA, no el recortado
npm run dev
TOKEN=$(grep PANEL_PASSWORD .env | cut -d= -f2)
curl -s 'http://localhost:3005/api/data/funnel?f=chauhinchazon&range=30d' \
  -b "panel_token=$TOKEN" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d['porEtapas']['etapas']:
    print(f\"{e['stageOrder']} {e['label']:22} {e['sessions']:>6}  pct={e['pctOfBase']:6.2f}  ancho={e['anchoDibujo']:6.2f}  {'INCONSISTENTE' if e['inconsistente'] else ''}\")
print('huerfanas:', d['porEtapas']['huerfanas'])"
# esperado en local: probablemente 0 sesiones (la base local casi no tiene
# datos: P-R04 del plan). Contra un dump de producción, la salida tiene que
# reproducir los 8 números del §2, con 821 en "Vio la venta" y su ancho
# recortado al de "Página de venta".
# Si ves sessions=820 en "Vio la venta", recortaste el NÚMERO: ese es el bug
# que D-R09 prohíbe.

# 5 — el gráfico se ve como un embudo
#     Abrí /embudo: los trapecios se angostan de arriba a abajo y NINGUNO se
#     ensancha. La etapa "Vio la venta" tiene la marca de inconsistente, y su
#     title explica por qué (dos fuentes distintas).

# 6 — LA LISTA PASO A PASO SIGUE AHÍ, con sus 22 pasos, y el peor paso sigue
#     resaltado. Esta pantalla no reemplaza la lista, la complementa (§1).

# 7 — NINGUNA FUNCIÓN SE PERDIÓ (§9.5 del plan). Uno por uno, del §5:
#     selector de funnel · RangePicker · toggle de base landing/start ·
#     filtros de variante, campaña, fuente y país · tablas de campañas,
#     variantes, países y dispositivos · banner de ingestWarnings.

# 8 — ?base= SOBREVIVE AL REFRESH (D-R14)
#     Cambiá el toggle de base, mirá que la URL tenga ?base=start, apretá F5.
#     esperado: sigue en "desde la 1ª pregunta". Y el link copiado a otra
#     pestaña abre con la misma base.

# 9 — huérfana: el caso que motivó usar slug (D-R07)
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE funnel_stages SET starts_at_slug='no_existe'
    WHERE starts_at_slug='expert_bridge'
      AND funnel_id=(SELECT id FROM funnels WHERE slug='chauhinchazon');"
# recargá /embudo: esperado → el embudo muestra 7 etapas, la pantalla AVISA
# que hay una etapa huérfana con su slug, y NO se cae.
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE funnel_stages SET starts_at_slug='expert_bridge'
    WHERE starts_at_slug='no_existe';"
# dejá la base como estaba.

# 10 — los números de la lista de pasos NO cambiaron (§9.4 del plan)
#      Anotá el conteo de 3 pasos antes de esta task y comparalos. El embudo
#      por etapas es un agregado NUEVO: no puede mover los pasos.

# 11 — no se tocó nada fuera de la fila T04 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# esperado: lib/queries/funnel.ts, lib/queries/funnel.test.ts,
# components/EmbudoChart.tsx, app/(panel)/embudo/**, app/api/data/funnel/route.ts.
```

## 8. Cuándo parar

**Bloqueante, pará y avisá:**

- **`sessions` de una etapa no es el número real** (verificación 4). Recortar el número es
  exactamente lo que D-R09 prohíbe.
- **Un trapecio se ensancha** en el gráfico: `anchoDibujo` no se está aplicando, o se aplicó sobre
  `pctOfBase` en lugar de sobre el `anchoDibujo` de la anterior (§4.5).
- **Los conteos de los pasos cambiaron** (verificación 10).
- **La lista paso a paso desapareció** o perdió filas. Con 22 y 27 pasos es la única vista que sirve
  para encontrar el paso exacto.
- **`funnel_stages` está vacía**: T01 no terminó bien y no hay nada que dibujar. No la sembres desde
  este task: el seed es de la 017.

**Anotalo en §10 del plan y seguí:**

- **P-R03: `viral_news` y `loading_steps` están fusionadas** dentro de Preguntas y Diagnóstico
  (D-R08), por decisión delegada. Cuando termines, **mostrale el embudo al usuario**: es la única
  decisión de este plan que cambia lo que él va a mirar todos los días, y separarlas es una fila en
  Config, sin migración.
- **`FunnelChart` de recharts no te deja hacer algo** (etiquetas que no entran, trapecios que no
  respetan el ancho, altura que no se adapta). Anotá qué probaste: la alternativa es dibujar los
  trapecios con `div`s y CSS, y esa es una decisión que conviene que el usuario conozca.
- **Encontrás otra frontera no monótona** además de la del §2 (por ejemplo en `reset`, o en otro
  rango). Anotá cuál y con qué números: `inconsistente` la va a marcar sola, pero si son muchas, el
  criterio de recorte capaz merece revisión.
- **La base local no alcanza para ver el embudo lleno** (P-R04 del plan). Anotá si verificaste con un
  dump de producción o si sólo viste el estado vacío: son dos afirmaciones muy distintas.
