# Prompts para correr el rediseño

Copiá y pegá. Un agente por task. Las compuertas entre olas no son opcionales: **una task que bloquea
a otras no está terminada hasta que su verificación pasa.**

Todos los prompts asumen que el agente arranca en `~/Desktop/funnel/dashboard-admin`.

---

## Antes de arrancar: anotá tres números

**Hacelo ahora, no después.** El criterio §9.4 del plan dice que el rediseño no puede mover un número,
y no hay con qué comparar si no los anotás antes.

```bash
cd ~/Desktop/funnel/dashboard-admin
npm run dev
```

Abrí `/resumen` y `/ventas` con rango **30d** y anotá:

| | valor |
|---|---|
| Neto total (Resumen, EUR) | |
| Órdenes (Resumen) | |
| Gasto en ads (Resumen, EUR) | |
| Neto de un funnel fijo (Ventas, 30d) | |
| Órdenes aprobadas de ese funnel | |

Y del embudo de `chauhinchazon`, 30 días, el conteo de tres pasos cualquiera.

Al final del rediseño **tienen que ser idénticos**. Un número que se movió es un bug de cálculo
disfrazado de cambio visual.

---

## Ola A0 — T01, sola

**Nada corre en paralelo con esta.** T01 bloquea a las seis restantes: escribe los tokens, la fuente,
los primitivos de `ui.tsx`, los contratos de tipos y la migración 017.

```
Trabajás en ~/Desktop/funnel/dashboard-admin.

Leé estos dos archivos completos antes de escribir una línea de código:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T01-fundacion-visual.md

Implementá T01 completa. Reglas que no se negocian:

- Sólo podés crear o modificar los archivos de la fila T01 de la tabla de §8 del
  plan. Ningún otro. Si creés que necesitás otro archivo, anotalo en §10 del plan
  y seguí.
- components/ui.tsx SÓLO SE AGREGA: no cambies la firma de ninguno de los 15
  exports que ya tiene. Las 8 pantallas lo importan y tres están en producción.
- db/migrations/017_rediseno_ui.sql es una COPIA TAL CUAL de
  redesign-ui-tasks/_schema-017.sql. No lo mejores, no lo reordenes.
- lib/widgets/tipos.ts tiene que quedar con los tipos COMPLETOS de §4 y §5 del
  plan, no elididos. Seis tasks los importan y ninguna los puede modificar.
- La base local está en la migración 010: `npm run db:migrate` va a aplicar de la
  011 a la 017 de una. Es lo esperado.

Corré la verificación del §9 de la task, los 10 puntos, incluido abrir las 8
pantallas en el browser. Reportá el resultado de cada uno. Si el punto 5 (las
firmas de ui.tsx) o el 6 (las 8 pantallas) fallan, pará y avisá.
```

### Compuerta A0 → A

No arranques la ola A hasta que esto dé verde:

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
npm run db:migrate && npm run db:migrate    # la segunda: 0 aplicadas
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT f.slug, count(*) FROM funnel_stages st JOIN funnels f ON f.id=st.funnel_id GROUP BY 1;"
# esperado: 8 etapas por funnel. Si da 0, T04 y T07 no tienen nada que hacer.
```

Y a ojo: las 8 pantallas abren y se ven igual que antes, salvo la fuente.

---

## Ola A — T02, T03 y T04 en paralelo

Tres agentes al mismo tiempo. **No se tocan ningún archivo** (§8 del plan).

### T02 — métricas

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01 ya está terminada y en el repo.

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T02-metricas-nuevas.md

Implementá T02 completa. Sólo podés tocar lib/queries/overview.ts,
lib/queries/sales.ts y sus dos archivos de test. Ningún .tsx, ningún route.

Lo que más fácil se hace mal, en orden:
1. Las unidades. fmtPct NO multiplica por 100 y las queries devuelven tanto por
   uno. Los campos nuevos siguen esa convención. Leé §2.1 de la task.
2. Los campos NUEVOS devuelven `number | null` sin denominador. Los VIEJOS se
   quedan en 0 y no se tocan: cambiarlos rompería vistas que no son tuyas. Leé
   §2.2, explica por qué.
3. Nada de SQL nuevo. Todo sale de campos que las queries ya traen.

Corré la verificación del §7, los 7 puntos. El punto 5 (los números que ya se
mostraban no cambiaron) es bloqueante.
```

### T03 — runtime de widgets

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01 ya está terminada y en el repo.

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T03-runtime-widgets.md

Implementá T03 completa. Sólo podés tocar components/WidgetGrid.tsx,
lib/widgets/layout.ts, lib/widgets/layout.test.ts y
app/api/config/ui-layout/route.ts.

Verificá con lib/widgets/catalogo-demo.tsx, que T01 dejó justo para eso. NO
toques app/(panel)/resumen/ ni ventas/: son de T05 y T06.

Lo que más fácil se hace mal, en orden:
1. Los tres estados del layout: fila en null (usar el default), {"v":1,
   "widgets":[]} (respetar el vacío) y con widgets. Si colapsás null con [], el
   usuario borra todos sus widgets, guarda, recarga y le vuelven los de fábrica.
   Es el §2 de la task y el test más importante.
2. El mapeo de `pantalla` a la clave de settings es CERRADO (z.enum), no una
   interpolación: con interpolación el endpoint puede escribir cualquier fila de
   la tabla de configuración.
3. KeyboardSensor de @dnd-kit es obligatorio (D-R16). Un drag sin teclado deja el
   panel inoperable para quien no usa mouse.
4. Un id de widget que no está en el catálogo se ignora y se avisa. Nunca tira, y
   la pantalla nunca queda en blanco.

Corré la verificación del §6, los 10 puntos. Los puntos 2, 3, 5, 6 y 7 son
bloqueantes. Si dejaste una página de prueba, borrala.
```

### T04 — embudo

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01 ya está terminada y en el repo.

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T04-embudo-etapas.md
  redesign-ui-tasks/_schema-017.sql   (los comentarios son el contrato)

Implementá T04 completa. Sólo podés tocar lib/queries/funnel.ts,
lib/queries/funnel.test.ts, components/EmbudoChart.tsx, app/(panel)/embudo/** y
app/api/data/funnel/route.ts.

Lo que más fácil se hace mal, en orden:
1. EL EMBUDO NO ES MONÓTONO Y ESTÁ MEDIDO. En producción, "Vio la venta" (821)
   tiene UNA sesión más que "Página de venta" (820), porque los pasos salen del
   histograma de max_step_index y los hitos de columnas propias. Se recorta el
   ANCHO del trapecio (anchoDibujo), NUNCA el número, y la etapa se marca como
   inconsistente. Leé §2 y D-R09. El test con esos 8 números es obligatorio.
2. El conteo de una etapa es el de su ÚLTIMO paso. No sumes los pasos: `sessions`
   ya es acumulado inverso y sumarlo da un número sin sentido.
3. Las unidades de funnel.ts son 0-100 (a diferencia de overview.ts y sales.ts,
   que van en tanto por uno). No unifiques nada: movería números en pantalla.
4. La lista paso a paso SE QUEDA. Con 22 y 27 pasos es la única vista que sirve
   para encontrar el paso exacto donde se cae la gente. El embudo la complementa.
5. recharts 2.15.4 ya exporta Funnel, FunnelChart, LabelList y Trapezoid.
   Cero dependencias nuevas.

Corré la verificación del §7, los 11 puntos. El punto 4 (el número real viaja,
no el recortado) y el 10 (los conteos de pasos no cambiaron) son bloqueantes.
```

### Compuerta A → B

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
```

Más:
- **T02**: los campos nuevos aparecen en `/api/data/overview` y `/api/data/sales`, y los ratios están en
  tanto por uno (un `convCheckoutToSale` de 0,28, no 28).
- **T03**: guardar vacío queda vacío, un `id` desconocido no rompe nada, el POST sin cookie da 401.
- **T04**: el embudo se ve como un embudo, ningún trapecio se ensancha, y "Vio la venta" muestra su
  número real con la marca de inconsistente.
- **Los tres números que anotaste al principio siguen iguales.**

Si T02 no terminó, **T05 y T06 no compilan**: sus catálogos usan los campos nuevos.

---

## Ola B — T05 y T06 en paralelo

Dos agentes. **No se tocan ningún archivo.**

### T05 — Resumen

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01, T02 y T03 están terminadas.

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T05-resumen.md

Implementá T05 completa. Sólo podés tocar app/(panel)/resumen/** y
lib/widgets/catalogo-resumen.tsx.

Lo que más fácil se hace mal, en orden:
1. EL LAYOUT POR DEFECTO TIENE QUE VERSE COMO LA PANTALLA DE HOY. Resumen es la
   pantalla que mejor está y es el modelo de jerarquía del plan: un usuario que no
   toca nada no debería notar que cambió el sistema.
2. `import type` para los tipos de lib/queries/overview.ts. Un import de valor
   arrastra pg al bundle del browser.
3. Las unidades (tanto por uno, fmtPct no multiplica) y los null: un campo nuevo
   sin denominador muestra "—", no 0. Leé T02 §2.
4. El banner de rollup viejo y el pie con lastRollupAt NO son widgets: si el cron
   está muerto, el aviso no puede depender de que el usuario tenga ese widget.

Corré la verificación del §4, los 9 puntos. Los puntos 1, 2 y 6 son bloqueantes.
```

### T06 — Ventas

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01, T02 y T03 están terminadas.

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T06-ventas.md

Implementá T06 completa. Sólo podés tocar app/(panel)/ventas/** y
lib/widgets/catalogo-ventas.tsx.

Esta es la pantalla que motivó el rediseño: 746 líneas, 12 StatCards en
lg:grid-cols-5 y 6 Banners. El objetivo es JERARQUÍA, no cosmética. Doce números
del mismo tamaño no tienen jerarquía: hay que dejar pocos y grandes arriba y el
resto disponible en el catálogo. Ningún número se pierde.

Lo que más fácil se hace mal, en orden:
1. `import type` para los tipos de lib/queries/sales.ts. Un import de valor
   arrastra pg al bundle. El propio archivo lo dice arriba de upsellTakeRate.
2. Las unidades: los ratios de sales.ts van en tanto por uno, PERO
   upsellTakeRate devuelve 0-100. Es la única excepción del archivo.
3. El toggle EUR/ARS: cada importe tiene su par Orig/Eur. No convertias nada en el
   componente, cada día se convirtió con su propia cotización.
4. ?cur= va al query string, pero el valor inicial sale de
   settings.default_currency_view. No pierdas el setting.
5. El cajón sin atribuir (?f=__unattributed__) es el único camino a esas órdenes
   y es fácil de romper al rehacer el selector.

Corré la verificación del §6, los 13 puntos. Los puntos 1, 2, 3, 8 y 11 son
bloqueantes.
```

### Compuerta B → C

```bash
npx tsc --noEmit && npm run build && npm test
npm run build 2>&1 | grep -iE "\bpg\b|Module not found" || echo "OK: sin pg en el bundle"
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT key, value IS NULL AS vacio FROM settings WHERE key LIKE 'ui_layout%';"
# esperado: 2 filas
```

Y a ojo: en las dos pantallas, editar → arrastrar → cambiar tamaño → guardar → F5 mantiene el layout.
Guardar Ventas no pisó Resumen. **Los cinco números que anotaste siguen iguales.**

---

## Ola C — T07, sola

```
Trabajás en ~/Desktop/funnel/dashboard-admin. T01 está terminada (las demás
también, pero esta task no depende de ellas).

Leé completos:
  redesign-ui-tasks/00-PLAN-REDISENO.md
  redesign-ui-tasks/T07-config-y-resto.md
  redesign-ui-tasks/_schema-017.sql   (para el editor de etapas)

Implementá T07 completa. Sólo podés tocar app/(panel)/config/**,
app/(panel)/leads/**, app/(panel)/anuncios/**, components/Nav.tsx,
app/(panel)/layout.tsx, app/api/config/steps/route.ts y
app/api/config/stages/route.ts.

Es el task más grande: 5 pantallas y 1.528 líneas sólo de Config. Está ordenado
por importancia y conviene respetarlo:

1. §2 ES UN BUG DE PRODUCCIÓN. El POST de "Importar pasos" hace DELETE+INSERT sin
   incluir counts_in_funnel, así que la resetea a true en cada importación y borra
   en silencio un ajuste que lib/funnels.ts sí lee. Arreglalo con un test que lo
   lockee. Es la razón número uno de este task.
2. §3 es la queja textual del usuario ("la de config que es una verga"): 9
   secciones en 1.528 líneas sin navegación interna. Partila en archivos, no sólo
   en pestañas, y agrupá las 9 en pocos grupos.
3. §4 es el editor de etapas, lo que hace configurable por funnel el embudo de
   T04. Validá en el route y devolvé 400 con motivo en castellano: un 500 de
   Postgres no es un mensaje usable.
4. §6: ANUNCIOS ESTÁ EN PRODUCCIÓN con un worker que puede escribir en Meta. Ahí
   el alcance es ESTRICTAMENTE visual. No toques lib/ads/**, ni los payloads, ni
   ads_rules_enabled / ads_rules_force_dry_run.

Antes de tocar Config, listá TODAS las acciones de las 9 secciones (cada guardar,
alta, baja y toggle) y verificalas una por una al terminar: un formulario
desconectado no da error de compilación, simplemente no guarda.

Corré la verificación del §8, los 13 puntos. Los puntos 1, 2, 5 y 8 son
bloqueantes.
```

---

## Al final: el cierre

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
npm run db:migrate && npm run db:migrate
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
```

Y a mano, los criterios de §9 del plan que ninguna task puede verificar sola:

1. **Los números que anotaste al principio son idénticos.** Es el criterio más importante de todo el
   rediseño.
2. **Las 8 pantallas abren**: `/resumen` `/embudo` `/ventas` `/leads` `/anuncios` `/anuncios/reglas`
   `/anuncios/historial` `/config`.
3. **Ninguna perdió una función.** Cada task tiene su lista; revisá que cada una la haya marcado.
4. **Todo se puede usar con teclado**, con foco visible, y el arrastre tiene alternativa de teclado.
5. **Cero `window.alert`, cero `console.log` de debug, cero código comentado.**

```bash
grep -rn "window.alert\|console\.log" app/ components/ lib/ --include=*.tsx --include=*.ts \
  | grep -v ".test.ts" || echo "OK: limpio"
grep -rn "▾\|▲\|▼\|↓\|↑" app/ components/ --include=*.tsx || echo "OK: sin iconos de texto"
```

6. **Leé §10 del plan.** Cada task fue anotando ahí lo que no pudo decidir. Es la lista de lo que
   queda por resolver, y es donde están P-R01 a P-R05.

7. **Mostrale el embudo al usuario antes de dar el rediseño por terminado** (P-R03). El seed fusionó
   `viral_news` dentro de Preguntas y `loading_steps` dentro de Diagnóstico por una decisión delegada.
   Es la única decisión del plan que cambia lo que va a mirar todos los días, y separarlas es agregar
   una fila desde Config, sin migración.

### El deploy no es parte de esto

Ninguna task despliega. El deploy es manual, con el script que ya existe:

```bash
sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
```

**La 017 se aplica sola en el deploy** (el script corre las migraciones), y es aditiva e idempotente.
Aun así, mirá que `funnel_stages` haya quedado sembrada en producción: los slugs de los dos funnels son
los mismos que en local, pero es lo primero que hay que confirmar del otro lado.

---

## Si preferís ir de a uno

El orden que deja ver el sistema de widgets funcionando lo antes posible:

```
T01 → T03 → T02 → T05 → T06 → T04 → T07
```

T03 antes de T02 se puede porque el runtime se verifica con `catalogo-demo`. Pero **T05 y T06 necesitan
T02 sí o sí**: sus catálogos usan los campos nuevos y sin ellos no compilan.
