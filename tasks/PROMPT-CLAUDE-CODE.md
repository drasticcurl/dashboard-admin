# Prompts para Claude Code

Cómo correr las 12 tasks. Un prompt por task, listo para pegar.

---

## Antes de arrancar

```bash
cd ~/Desktop/funnel/dashboard-admin/tasks && ls
# 00-PLAN.md  T01…T12  PROMPT-CLAUDE-CODE.md
# _schema-canonico.sql      ← el DDL completo, ya probado contra PostgreSQL 16
# _verificacion-logica.sql  ← 11 pruebas de la lógica del plan, ya corridas y en verde
```

Los dos `.sql` no son documentación: son ejecutables. El schema del §3 del plan **ya se corrió** en un
Postgres 16 real (limpio e idempotente) y las 11 afirmaciones de lógica que el plan hace —la semántica
de `LEAST` con NULL, que la atribución no se sobrescribe, la suma acumulada inversa del embudo, el
ruteo de particiones, el día local por zona horaria— **ya están verificadas**. T01 los usa como punto
de partida en vez de tipear el DDL de nuevo.

Tres cosas que hay que saber:

1. **T01 va sola y primero.** Crea el schema y las librerías compartidas que importan cinco tasks. Si
   arrancás otra en paralelo con T01, va a escribir contra archivos que todavía no existen.
2. **El plan es el contrato.** `00-PLAN.md` §3 (schema), §4 (ingest), §5 (webhook), §6 (eventos) y §8
   (qué archivos puede tocar cada task) son lo que evita que dos agentes en paralelo produzcan
   piezas que no encajan. Ningún agente lo modifica; si necesita algo que no está, lo anota en §10.
3. **Cada task corre su propia verificación.** Está al final de su archivo. Un task sin verificación
   corrida no está terminado, y "compila" no es verificación.

## El orden

```
Paso 1   T01                          1 agente,  solo
Paso 2   T02 · T03 · T04 · T05        4 agentes en paralelo
         T10 · T11                    2 agentes más, en los repos de los funnels
Paso 3   T06 · T07 · T08 · T09        4 agentes en paralelo   (necesitan T05)
Paso 4   T12                          1 agente
```

Seis agentes a la vez en el paso 2. Si preferís ir más tranquilo: `T01` → `T05` → el resto.

**Por qué se puede paralelizar sin que se pisen:** §8 del plan asigna a cada task un conjunto de
archivos exclusivo, y **todas** las dependencias de npm las declara T01, así que nadie más toca
`package.json`. T10 y T11 viven en repos distintos (`testfunnel` y `reset-app`), así que no hay riesgo
entre ellas ni con las demás.

**Lo que no se puede:** dos tasks del mismo paso escribiendo el mismo archivo. Si un agente te dice que
necesita editar algo que no está en su fila de §8, la respuesta es no: que lo anote en §10.

---

## Preámbulo (va al inicio de cada prompt)

> Trabajás en un monorepo en `~/Desktop/funnel`. El proyecto nuevo es `dashboard-admin`: un panel de
> tracking y ventas unificado para varios funnels, con PostgreSQL propio en la VPS.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `~/Desktop/funnel/dashboard-admin/tasks/00-PLAN.md` — el documento maestro. §3 es el schema
>    canónico, §4 y §5 son contratos congelados, §6 el vocabulario de eventos, §8 dice qué archivos
>    podés tocar.
> 2. `~/Desktop/funnel/dashboard-admin/tasks/<TU-TASK>.md` — tu tarea.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §8 del plan.** Otros agentes están trabajando en
>   paralelo sobre los otros archivos. Si creés que necesitás tocar uno ajeno, no lo toques: anotalo
>   en §10 del plan con el formato que está ahí.
> - **No instalás dependencias ni editás `package.json`.** T01 declaró todo lo necesario. Si te falta
>   un paquete, va a §10.
> - **No cambiás el schema ni los contratos.** Están congelados porque otros tasks se escriben contra
>   ellos al mismo tiempo.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código**: la anotás en §10.
>   Si bloquea, parás y me avisás.
> - Todo el SQL va con parámetros (`$1`, `$2`), nunca concatenando valores.
> - Los comentarios en el código explican **por qué**, no qué. El estilo de referencia son las
>   migraciones y el `deploy/Caddyfile` de `~/Desktop/funnel/testfunnel`: explican el bug que la
>   decisión evita.
> - Al terminar, corré la sección de Verificación de tu task **completa** y pegame la salida. Si algo
>   falla, arreglalo antes de decir que terminaste.

---

## Paso 1

### T01 — Fundación

> [preámbulo, con `<TU-TASK>` = `T01-fundacion.md`]
>
> Ejecutá T01 completa: proyecto Next.js 14, `docker-compose.yml` con Postgres 16, las 10 migraciones
> del §3 del plan, los seeds de los dos funnels con sus 22 y 27 pasos, y las librerías compartidas
> (`lib/db.ts`, `lib/day.ts`, `lib/fx.ts`, `lib/funnels.ts`, `lib/types.ts`) más los tres scripts.
>
> Dos cosas con atención especial:
> - Las listas de pasos del §3.12 del plan hay que **verificarlas contra el código** de los dos
>   funnels antes de escribir el seed (el comando está en T01 §5). Si el código dice otra cosa, gana
>   el código y lo anotás en §10.
> - Las librerías compartidas las van a importar cinco tasks en paralelo y **no las van a poder
>   modificar**. Sus firmas tienen que quedar como las define T01, completas, aunque este task no las
>   use todas.

## Paso 2 — cuatro en paralelo

### T02 — Ingest API
> [preámbulo, `<TU-TASK>` = `T02-ingest-api.md`]
>
> Implementá el endpoint `POST /api/ingest` según el contrato del §4 del plan, que está congelado
> porque T10 y T11 están escribiendo el cliente contra él en paralelo. Lo que más importa: que sea
> idempotente (reenviar un lote no puede mover ningún número de `sessions`) y que **nunca** descarte
> datos por no entenderlos (§D20 del plan).

### T03 — Cotizaciones
> [preámbulo, `<TU-TASK>` = `T03-cotizaciones-fx.md`]
>
> Implementá el fetcher diario ARS→EUR y el backfill. Ojo con el error fácil de este task:
> `dolarapi` devuelve **pesos por euro** (hay que invertir) y `open.er-api.com` devuelve **euros por
> peso** (no hay que invertir). Y `assertPlausible` no es opcional: una API que devuelve 0 hace que
> todas las ventas del día valgan 0 euros sin que nada falle.

### T04 — Webhook de Shopify
> [preámbulo, `<TU-TASK>` = `T04-webhook-shopify.md`]
>
> Implementá el webhook centralizado según el §5 del plan. **Antes de escribir, leé completo
> `~/Desktop/funnel/testfunnel/app/api/shopify-webhook/route.ts`**: ese archivo ya resolvió en
> producción la firma HMAC contra el body crudo, la idempotencia y la herencia de UTMs. Este task es
> ese archivo sin Meta CAPI, sin Supabase y con el modelo nuevo. Copiá sus soluciones.
>
> Es el camino de la plata: una venta no se descarta nunca (§D10), y una firma inválida no se acepta
> nunca.

### T05 — Auth, shell y kit de UI
> [preámbulo, `<TU-TASK>` = `T05-auth-shell-ui.md`]
>
> Auth, shell y `components/ui.tsx`. Dos cosas:
> - El auth se **copia** de `~/Desktop/funnel/testfunnel/lib/admin/auth.ts` (HMAC del timestamp,
>   `timingSafeEqual`, rate limit por IP). No lo reinventes.
> - El matcher del `middleware.ts` **tiene que excluir `/api/ingest` y `/api/webhooks/*`**. Si los
>   intercepta, el tracking y las ventas dejan de entrar y el panel muestra ceros creíbles sin
>   ningún error visible. Es el modo de falla más difícil de diagnosticar del proyecto: verificalo
>   con el `curl` que está en la verificación del task.
>
> `components/ui.tsx` lo van a importar cuatro tasks en paralelo sin poder modificarlo: exportá todo
> lo que la lista del task pide, aunque no lo uses acá.

## Paso 2 (bis) — los dos funnels, en paralelo con lo anterior

### T10 — testfunnel
> [preámbulo, `<TU-TASK>` = `T10-instrumentar-testfunnel.md`]
>
> Trabajás **solo** dentro de `~/Desktop/funnel/testfunnel`. Es un funnel que está vendiendo hoy.
>
> La regla que ordena todo el task: **Meta CAPI no se toca y no se rompe.** El punto 4 de la
> verificación pide evidencia de que sigue andando (log de `events_received` o el evento en Test
> Events de Meta): sin esa evidencia el task no está terminado.
>
> Segunda regla: el webhook de Shopify de este repo **se queda** (alimenta `purchases` en Supabase,
> que es lo que habilita el contenido del upsell en la PWA). Solo se le saca el `getStore().track()`.

### T11 — reset-app
> [preámbulo, `<TU-TASK>` = `T11-instrumentar-reset-app.md`]
>
> Trabajás **solo** dentro de `~/Desktop/funnel/reset-app`.
>
> T11 es la misma tarea que T10 en otro repo: leé **los dos** archivos, `T10` completo (es la
> especificación) y `T11` (son las nueve diferencias). Las que más importan: el slug es `reset`, el
> `variant` es `'default'` y no `'ar'`, son 27 pasos, y el `middleware.ts` de este repo también
> protege la PWA — si al sacar las referencias a `/admin` se rompe ese guard, revertí el archivo.
>
> Igual que en T10: CAPI no se rompe, y hace falta evidencia.

## Paso 3 — cuatro en paralelo (después de T05)

### T06 — Embudo
> [preámbulo, `<TU-TASK>` = `T06-seccion-embudo.md`]
>
> La sección Embudo. Leé `~/Desktop/funnel/testfunnel/app/admin/funnel/FunnelView.tsx` líneas
> 203-244: es la matemática que el usuario quiere conservar (el 100% es el paso 0, con toggle al paso
> 1). Lo que cambia es de dónde salen los números.
>
> El embudo se calcula con **dos** queries y una suma acumulada inversa en TypeScript, no con un
> `count` por paso. Y no muestra plata: eso es T07.

### T07 — Ventas
> [preámbulo, `<TU-TASK>` = `T07-seccion-ventas.md`]
>
> La sección Ventas. Bruto, devuelto y **neto** son tres números distintos y los tres se muestran: el
> panel viejo contaba las devoluciones como ventas y nunca las restaba, y eso es lo que se está
> arreglando.
>
> Cuidado con `($1::smallint IS NULL OR funnel_id = $1)`: con `$1 = NULL` devuelve **todo**, no las
> ventas sin funnel. El cajón "sin atribuir" necesita su propia rama `funnel_id IS NULL`.

### T08 — Resumen unificado
> [preámbulo, `<TU-TASK>` = `T08-resumen-unificado.md`]
>
> El Resumen es la pantalla que justifica el proyecto: todos los funnels sumados, en euros.
>
> El test más importante del task es el 4: el neto del Resumen tiene que coincidir **exactamente** con
> el neto de la sección Ventas de cada funnel para el mismo rango. Si no coincide, hay dos verdades en
> el panel y no se usa más. No ajustes un lado hasta que dé: encontrá la causa.
>
> El rollup **recalcula**, no acumula. Un rollup que suma incrementos se desincroniza a la primera
> corrida doble.

### T09 — Leads y Configuración
> [preámbulo, `<TU-TASK>` = `T09-leads-y-configuracion.md`]
>
> Dos partes. Leads lee de Supabase por la API REST (sin agregar `@supabase/supabase-js`), y su razón
> de ser es que T10/T11 borran el `/admin` de los funnels y con él el export de leads a Shopify: ese
> CSV **tiene que salir con el formato exacto** del `/api/admin/leads-export` viejo, porque es lo que
> Shopify acepta. Copialo, no lo mejores.
>
> Configuración es lo que hace operable el sistema: sin la tabla de productos → tier, las ventas no
> se pueden atribuir. Incluí el re-proceso de las órdenes viejas al mapear un producto, o mapear solo
> sirve para el futuro.

## Paso 4

### T12 — Histórico y deploy
> [preámbulo, `<TU-TASK>` = `T12-historico-y-deploy.md`]
>
> Importá el histórico de `purchases` de los dos Supabase a `orders`, y escribí los artefactos de
> deploy (PM2, bloque de Caddy, `deploy.sh`, cron) más el runbook. **No ejecutás el deploy**: eso lo
> hago yo después.
>
> El criterio de que la importación salió bien: el conteo y la suma por status tienen que coincidir
> con lo que dice Supabase. Si no coinciden, lo más probable es la paginación de PostgREST, que
> trunca en 1000 filas en silencio. Un histórico mal importado es peor que ninguno.

---

## Qué revisar cuando terminan

En este orden, porque cada uno depende del anterior:

```bash
# 1 — los tres repos compilan y sus tests pasan
for d in dashboard-admin testfunnel reset-app; do
  echo "── $d"; ( cd ~/Desktop/funnel/$d && npx tsc --noEmit && npm run build >/dev/null && npm test )
done

# 2 — el panel viejo no dejó restos
for d in testfunnel reset-app; do
  echo "── $d"; ( cd ~/Desktop/funnel/$d &&
    grep -rn "lib/admin\|getStore\|FUNNEL_STORE\|funnel_counts" app components lib || echo "limpio" )
done

# 3 — el circuito completo, con todo levantado
#     · /quiz de un funnel → aparece una sesión en el panel
#     · webhook de prueba con firma válida → aparece la orden
#     · /resumen muestra los dos funnels
#     · el neto del Resumen == el neto de Ventas para el mismo rango

# 4 — CAPI. Test Events del Administrador de eventos de Meta, los dos funnels.
#     Es el único punto que no se puede verificar con un grep, y es el que más duele si falla.

# 5 — §10 del plan: leé las preguntas abiertas que quedaron anotadas.
```

Si el paso 4 no da, no despleguemos: un funnel sin CAPI pierde la optimización de las campañas y eso
cuesta plata todos los días.
