# Toggle de conjuntos y entrega — Bugfix Design

## Overview

Son cuatro defectos con dos naturalezas y el diseño los mantiene separados,
porque la introducción del bugfix ya cerró que arreglar uno no arregla al otro.

**Latencia** (bugs 1, 2 y 4): el click puede tardar más de un minuto, y en el
camino de una fila puede no terminar nunca. Tres arreglos independientes entre sí
salvo por un acoplamiento que se declara abajo:

1. **Bug 1** — el umbral de frescura queda exactamente en la edad máxima que
   produce una corrida sana, así que la relectura contra Meta se dispara en el
   camino crítico cuando el dato local alcanzaba. Se le agrega un margen
   **derivado del período del cron**, y el período pasa a vivir en código con un
   test que lo compara contra `deploy/cron.panel`.
2. **Bug 2** — el POST del toggle de una fila no tiene plazo y el del lote tiene
   uno menor que el peor caso del servidor. Los dos plazos y el peor caso pasan a
   salir de **un solo módulo** que los calcula en función de la cantidad de
   objetos, con un test que verifica la desigualdad.
3. **Bug 4** — `refrescarJerarquia` hace un `fetchObjeto` de 30 s en el camino
   crítico para refrescar un dato que el propio código declara prescindible. Sale
   del camino crítico, y la dependencia de 1.19 se resuelve **escribiendo en la
   base el `status` que Meta acaba de confirmar** —sin ir a Meta— antes de
   responder.

**Semántica de entrega** (bug 3): el interruptor está cableado a `status`, así
que para los 92 conjuntos `ACTIVE` con `effective_status = CAMPAIGN_PAUSED` se
dibuja encendido y verde sobre algo que no entrega. El control gana un **tercer
estado** que es un dato adicional y ortogonal a la posición, y la fila gana un
camino a la campaña. Nada de esto cambia el tiempo de espera.

### Se puede shippear por partes, y en este orden

Cuatro tandas. Tres son independientes; una tiene una dependencia real.

| Tanda | Qué cierra | Depende de | Ships sola |
|---|---|---|---|
| **A** | Bug 1 — margen del umbral (2.1–2.4) | — | Sí |
| **B** | Bug 3 — tercer estado, aviso al pausar, navegación (2.9–2.12) | — | Sí |
| **C** | Bug 4 — `refrescarJerarquia` fuera del camino crítico (2.13–2.15) | — | Sí |
| **D** | Bug 2 — plazos del cliente (2.5–2.8) | **C** (ver abajo) | Sí, con el número del mundo pre-C |

**B se subdivide** y las dos mitades son shippeables por separado: **B1** es el
aviso al pausar (`lib/ads/previsualizacion.ts`, sólo servidor, cero cambios de
cliente) y **B2** es el tercer estado más la navegación (sólo cliente). B1 no
necesita B2 ni al revés.

**El acoplamiento C↔D, explícito.** El plazo del cliente tiene que ser mayor que
el peor caso del servidor (2.7). Ese peor caso, para un objeto, es hoy **~64 s**
= 4 s de `PRESUPUESTO_RELECTURA_MS` + 30 s del `AbortSignal.timeout` de `enviar`
+ 30 s del `fetchObjeto` de `refrescarJerarquia`. Cuando C entra, el tercer
término desaparece del camino crítico y el peor caso baja a **~34 s**.

- **C antes que D** (recomendado): D se calcula una sola vez, con 34 s, y el
  plazo del toggle de una fila queda en 44 s.
- **D antes que C**: D tiene que calcularse con 64 s y el plazo queda en 74 s.
  Cuando C entre después, el plazo baja solo, porque los dos números salen de la
  misma suma en `lib/ads/plazos.ts` y C borra un término de esa suma en el mismo
  commit que mueve la llamada.
- **Lo que NO se puede hacer** es shippear D con el número del mundo post-C
  mientras C no está desplegado: un click cuyo servidor tarda 64 s se abandonaría
  a los 44 s y produciría un desenlace `indeterminado` sobre un pedido que estaba
  por confirmarse, que es exactamente lo que 2.7 prohíbe. La guarda contra eso no
  es la memoria de nadie: es que el término del refresco esté en el módulo de
  plazos y que un test del route pruebe que la respuesta no lo espera (§Testing
  Strategy, Property 7).

## Glossary

- **Bug_Condition (C)**: unión de cuatro condiciones disjuntas, una por defecto.
  No hay una sola C: C(X) = C₁(X) ∨ C₂(X) ∨ C₃(X) ∨ C₄(X), y cada tanda cierra un
  disyunto. Se escriben las cuatro en §Bug Details.
- **Property (P)**: el comportamiento correcto para cada disyunto de C. También
  son cuatro, y están numeradas en §Correctness Properties.
- **Preservation**: para todo input que no cumple ningún disyunto de C, el
  comportamiento no cambia. Las excepciones declaradas a propósito están en
  §Expected Behavior.
- **Periodo_Cron** (900 s): cada cuánto corre `scripts/sync-ads-jerarquia.ts`.
  Vive en `deploy/cron.panel:113` como `*/15`.
- **Umbral_Frescura** (`ads_frescura_umbral_segundos`, 900): a partir de cuántos
  segundos un `synced_at` se considera viejo. Vive en `settings` (jsonb) y su
  default está repetido en cuatro lugares del código.
- **Umbral_Relectura**: el umbral CON margen, y el único que decide si se dispara
  una lectura a Meta en el camino crítico. Nuevo. No es el Umbral_Frescura: son
  dos preguntas distintas sobre el mismo número (ver decisión A1).
- **Margen_Relectura**: cuánto se le suma al Umbral_Frescura para llegar al
  Umbral_Relectura. Derivado del Periodo_Cron.
- **Peor_Caso_Servidor**: cota superior del tiempo que el `Endpoint_Acciones`
  puede tardar en responder un `pause`/`activate` de n objetos, sumando los
  timeouts de las llamadas a Meta. Es una cota sobre las llamadas a Meta, **no
  sobre el request entero**: la base y el preflight no tienen deadline.
- **Plazo_Cliente**: el `AbortSignal.timeout` del POST, función de n. Siempre
  mayor que el Peor_Caso_Servidor.
- **Senal_Entrega**: lo que `effective_status` permite AFIRMAR sobre la entrega de
  una fila que dibuja interruptor. Dos valores, y ninguno es «entrega».
- **Refresco_Diferido**: la llamada a `refrescarJerarquia` después de que la
  respuesta salió.
- **Escritura_Confirmada_Local**: el `UPDATE` de `status` con el valor que Meta
  acaba de confirmar, sin ir a Meta. Es lo que reemplaza al refresco en el camino
  crítico.
- **F**: el código como está hoy. **F'**: el código con las cuatro tandas.

## Bug Details

### Bug Condition

C es una unión de cuatro predicados sobre cuatro dominios distintos. Escribirla
como un solo predicado obligaría a inventar un input común a un click del panel,
un `synced_at` de la base y una fila de la tabla, y ese input no existe.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X de tipo InputDelPanel
  OUTPUT: boolean

  RETURN esC1_UmbralSinMargen(X)
      OR esC2_PostSinPlazo(X)
      OR esC3_ControlSinEntrega(X)
      OR esC4_RelecturaEnCaminoCritico(X)
END FUNCTION
```

#### C₁ — el umbral no tiene margen (bug 1)

```pascal
FUNCTION esC1_UmbralSinMargen(X)
  INPUT: X = { accion, syncedAt, desaparecidoAt, ahora, umbral, periodo }
  OUTPUT: boolean

  // Sólo pause/activate releen: `relecturaSelectiva` corta antes para el resto.
  IF X.accion NOT IN ['pause', 'activate'] THEN RETURN false

  // Los tres casos de 3.15 NO son C: ahí la relectura tiene que dispararse.
  IF X.desaparecidoAt <> NULL THEN RETURN false
  IF X.syncedAt = NULL OR NOT esFechaLegible(X.syncedAt) THEN RETURN false

  edad ← segundosEntre(X.syncedAt, X.ahora)

  // La ventana que este bug agrega: el objeto se sincronizó en la última corrida
  // sana y aun así se relee, porque el umbral es igual al período.
  RETURN edad > X.umbral
     AND edad <= X.periodo + duracionDeLaCorrida(X)
END FUNCTION
```

Con `umbral = periodo = 900`, esa ventana es no vacía para cualquier duración de
corrida mayor que cero, y su ancho es exactamente la varianza de la corrida más
el jitter del cron. Y a partir de la primera corrida que falla o que no trae el
objeto, la edad no vuelve a bajar del umbral (1.3): el objeto queda con
`edad > 900` para siempre y el disyunto se cumple en TODOS los clicks. Ésa es la
mitad del bug que el margen **no** tiene que tapar.

#### C₂ — el POST sale sin plazo o con uno insuficiente (bug 2)

```pascal
FUNCTION esC2_PostSinPlazo(X)
  INPUT: X = { camino, n, plazoCliente, peorCasoServidor }
  OUTPUT: boolean

  IF X.camino = 'fila' THEN
    RETURN X.plazoCliente = NINGUNO          // `fetch(url, init)` pelado
  IF X.camino = 'lote' AND X.accion <> 'duplicate' THEN
    RETURN X.plazoCliente <= X.peorCasoServidor(X.n)
  RETURN false                               // duplicate: 300 s, fuera de C
END FUNCTION
```

#### C₃ — el control no habla de la entrega (bug 3)

```pascal
FUNCTION esC3_ControlSinEntrega(X)
  INPUT: X = fila con { status, effectiveStatus }
  OUTPUT: boolean

  dibujo ← dibujoDeEstado(X)
  IF dibujo.control = 'badge' THEN RETURN false   // 3.10: no tiene interruptor

  // El interruptor se dibuja encendido y verde, y Meta dice que un antepasado
  // lo tiene sin entregar.
  RETURN dibujo.encendido = true
     AND X.effectiveStatus IN ['CAMPAIGN_PAUSED', 'ADSET_PAUSED']
END FUNCTION
```

**Esto es exactamente lo que `effective_status` puede afirmar, y no más.** El
repo ya verificó (`lib/ads/previsualizacion.ts:184` y el subselect de
`leerObjetos` en `lib/ads/acciones.ts`) que **Meta resuelve `effective_status`
con el estado PROPIO antes que con el del padre**: un conjunto `PAUSED` bajo una
campaña `PAUSED` viene con `effective_status = 'PAUSED'`, no `'CAMPAIGN_PAUSED'`.
Contra el reparto verificado de 169 conjuntos:

| `status` | `effective_status` | conjuntos | ¿cumple C₃? |
|---|---|---|---|
| ACTIVE | CAMPAIGN_PAUSED | **92** | **Sí** |
| PAUSED | PAUSED | 67 | No — el interruptor está apagado y el objeto no entrega: no miente |
| ACTIVE | ACTIVE | 10 | No — entrega |

Los 67 quedan afuera **de C, no del spec**: para ellos el interruptor dice la
verdad. Lo que les falta —saber que activarlos no va a hacerlos entregar— ya lo
cubre la advertencia del servidor al activar, que sí tiene el `status` del padre
(decisión B3).

#### C₄ — la relectura de la jerarquía está en el camino crítico (bug 4)

```pascal
FUNCTION esC4_RelecturaEnCaminoCritico(X)
  INPUT: X = { accion, desenlaceDeMeta }
  OUTPUT: boolean

  RETURN X.accion IN ['pause', 'activate']
     AND X.desenlaceDeMeta = 'confirmado'
     AND laRespuestaEsperaA('refrescarJerarquia')
END FUNCTION
```

Se cumple para el 100 % de las acciones de estado confirmadas: la llamada está en
`app/api/ads/acciones/route.ts:576`, con `await`, justo después de
`cerrarAccion(id, 'confirmado')`.

### Examples

Los números de la columna «hoy» salen de leer el código y sumar los timeouts
declarados, no de medir contra producción: el bugfix ya declaró que la base local
no tiene corridas de cron ni filas de `ad_actions` que sirvan como evidencia de
latencia real.

| Input | Disyunto | Hoy | Con el arreglo |
|---|---|---|---|
| Conjunto con `synced_at` de hace 905 s, cron sano, click en el interruptor | C₁ | `causaDeRelectura` → `'vieja'`; `fetchObjeto` en el camino crítico | decide con el dato local: `905 <= 900 + 450` |
| Conjunto que el cron no trajo en la última corrida (edad 1810 s) | ¬C₁ | relectura | **relectura igual**: `1810 > 1350` (2.2) |
| Conjunto con `desaparecido_at` puesto y `synced_at` de hace 5 s | ¬C₁ | relectura por `'desaparecida'` | igual, el margen no la toca (3.15) |
| Conjunto con `synced_at = NULL` | ¬C₁ | relectura por `'vieja'` | igual (3.15) |
| Toggle de una fila, servidor tarda 64 s | C₂ | el `fetch` no vuelve nunca; la fila queda pintada, el id queda en `enVuelo` y un segundo click se descarta | responde, o se aborta a los 44 s con desenlace indeterminado |
| Lote de `pause` sobre 1 conjunto, servidor tarda 64 s | C₂ | abortado a los 60 s: se abandona un pedido que estaba por confirmarse | plazo 44 s post-C / 74 s pre-C, siempre > peor caso |
| Lote de `pause` sobre 20 conjuntos | C₂ | 60 s contra un peor caso de 604 s | plazo 614 s (ver la consecuencia declarada en D2) |
| Lote de `duplicate` | ¬C₂ | 300 s | **300 s, sin cambio** (3.14) |
| Fila `ACTIVE` / `CAMPAIGN_PAUSED` | C₃ | interruptor verde, `aria-checked="true"`, sin ninguna diferencia con los 10 que entregan | interruptor **en la misma posición**, con tono de advertencia, nombre accesible que dice que no entrega y link a la campaña |
| Fila `PAUSED` / `PAUSED` bajo campaña pausada | ¬C₃ | apagado, sin aviso al pausar | apagado (sin cambio) + advertencia del servidor al activar (ya existe) |
| Fila `ACTIVE` / `PENDING_BILLING_INFO` | ¬C₃ | interruptor verde + badge «sin facturación» | igual: el tercer estado NO se extiende acá (decisión B2) |
| Fila `ARCHIVED` | ¬C₃ | badge | badge, sin `encendido` ni Senal_Entrega (3.10) |
| `pause` confirmado de un conjunto | C₄ | 4 s + 30 s + **30 s** antes de responder | 4 s + 30 s + un `UPDATE` local; la relectura sale después de la respuesta |
| `rename` confirmado | ¬C₄ | tiene su propia relectura en `route.ts:1192` y `:1401` | **sin cambio**: este spec no toca el camino de renombrado |

## Expected Behavior

El comportamiento correcto para cada disyunto está en §Correctness Properties.
Esta sección es lo que **no** cambia.

### Preservation Requirements

**Comportamientos que tienen que seguir exactamente iguales.** Agrupados por qué
tanda los pone en riesgo, porque cada tanda tiene su propio conjunto de vecinos
frágiles.

**Tanda A (bug 1) — la relectura**

- La relectura se sigue disparando con `desaparecido_at` no nulo, con
  `synced_at` nulo y con `synced_at` ilegible (3.15). El margen entra **como un
  cambio del número que se compara, no de la estructura de ramas**:
  `causaDeRelectura` devuelve `'desaparecida'` antes de mirar la edad, y
  `edad === null` devuelve `'vieja'` antes de la comparación. Los tres casos
  quedan intactos por construcción, no por cuidado.
- La relectura sigue siendo secuencial, con tope de `TOPE_RELECTURA = 10`, con
  `PRESUPUESTO_RELECTURA_MS = 4_000` para el lote entero, sin bloquear la acción
  cuando falla y dejando anotado por qué no se pudo revalidar (3.16). Nada de
  `relecturaSelectiva` se toca: el cambio es de una línea de `causaDeRelectura`.
- La Marca_Frescura de la tabla sigue marcando a los 900 s exactos, con `>` y no
  `>=`, y sigue dejando `al_dia` cuando el umbral no es finito. El margen **no**
  entra en `frescuraDeFila` (ver decisión A1).
- `topesDeSettings` sigue cayendo al default cuando `settings.value` no es un
  número o es negativo, y ese default sigue siendo 900.

**Tanda D (bug 2) — el desenlace del plazo vencido**

- Un POST cortado por timeout sigue siendo `indeterminado` y nunca éxito ni fallo
  (3.1). El plazo del cliente es una segunda instancia del mismo criterio: al
  vencerse **no se afirma que el cambio no ocurrió**.
- La reversión sigue tocando la fila sólo si todavía muestra el valor pintado, y
  sigue restaurando `statusPrevio` y no `PAUSED`/`ACTIVE` (3.2). El plazo entra
  por el `catch` que ya existe, sin cambiar la guarda.
- La reversión sigue decidiéndose con `aplicado` y no con la nulidad del aviso
  (3.3), y un `confirmado` con advertencia sigue sin revertir y sigue pidiendo el
  refetch (3.4).
- La guarda por id sigue descartando el segundo click y dos filas distintas siguen
  pudiendo tocarse a la vez (3.11).
- `duplicate` sigue con 300 s (3.14). `TOPES_ABORTO = 10_000` del refetch
  posterior al lote no se toca: es el presupuesto de una lectura, no de una
  escritura (3.13).
- El `AbortSignal.timeout(30_000)` de `enviar` y el de `pedir` de `lib/ads/meta.ts`
  siguen valiendo 30_000. Pasan a nombrarse desde una constante; el valor no
  cambia.

**Tanda B (bug 3) — la coherencia del control**

- `dibujoDeEstado` y `accionDeToggle` siguen saliendo de la MISMA comparación
  `status === 'ACTIVE'`, para todo valor de `status` incluidos `null`, `''` y los
  desconocidos (3.6). La Senal_Entrega **no participa** de esa derivación.
- El interruptor sigue quedando accionable en las dos direcciones después de una
  acción confirmada (3.7).
- El tipo sigue impidiendo derivar una posición de interruptor de una fila que
  dibuja badge, y el badge sigue sin quedar nunca en blanco con `''` contando como
  ausente (3.10). La Senal_Entrega vive **sólo en la rama `interruptor`**, por la
  misma razón por la que `encendido` vive sólo ahí.
- El badge de `TablaAds.tsx:254` sigue dibujándose cuando `effective_status`
  difiere de `status` (3.17): el tercer estado se suma, no lo reemplaza.
- La advertencia de padre apagado al ACTIVAR sigue diciendo las tres cosas que
  dice hoy, textualmente, y sigue siendo advertencia y no bloqueo (3.5). El
  mensaje nuevo es para `pause` y es **otro texto**.
- Se sigue escribiendo `status` con POST a `graph.facebook.com/{objectId}` con los
  mismos valores (3.8). El tercer estado es de dibujo: no cambia qué se le pide a
  Meta.

**Tanda C (bug 4) — el pintado y lo que ve el refetch**

- `conservarPintadoEnVuelo` sigue conservando el `status` en pantalla de los ids
  en vuelo (3.12), y la lectura de filas sigue teniendo su presupuesto y su número
  de secuencia, con una respuesta vieja sin poder pisar una más nueva (3.13).
- La fila de `ad_actions` sigue abriéndose ANTES del POST y las omisiones siguen
  dejando fila (3.9).
- `refrescarJerarquia` sigue **existiendo y corriendo**, con el mismo `UPDATE`,
  el mismo `catch {}` y la misma regla de no limpiar la marca cuando no vio la
  fila. Lo único que cambia es **cuándo** corre.

**Todas las tandas**

- El motor de reglas sigue apagado y forzado a dry-run (3.18). Ninguna tanda toca
  `ads_rules_enabled` ni `ads_rules_force_dry_run`.

### Alcance: qué queda afuera y con qué costo

Cuatro cosas que se evaluaron y **no** entran, cada una con lo que costaría y lo
que compraría. Están acá y no en un TODO porque son la mitad de las decisiones.

1. **El `status` del padre en la fila de la tabla.** Es lo que haría alcanzable el
   tercer estado para los 67 conjuntos `PAUSED` bajo campaña pausada. No entra:
   ver decisión B2 por el costo y por qué el beneficio es chico.
2. **El plazo de las otras acciones de lote.** `budget_set`, `rename` y `schedule`
   comparten el `AbortSignal.timeout(… : 60_000)` de `GestorAnuncios.tsx:1312` y
   tienen la misma clase de problema (escritura + relectura por objeto en serie
   contra un plazo fijo). 1.9 y 2.5–2.8 hablan de `pause`/`activate`, así que el
   módulo de plazos se define para el camino de estado y las otras acciones
   **quedan en 60 s**. Costo de extenderlo después: medir el peor caso de cada una
   y sumar un caso a la función. Riesgo de no hacerlo: el mismo defecto, en un
   camino que nadie reportó.
3. **La relectura del renombrado** (`route.ts:1192` y `:1401`) tiene su propia
   copia de la lógica de refresco y de la limpieza de `desaparecido_at`. Sigue
   sincrónica. Sacarla del camino crítico sería el mismo cambio que la tanda C,
   sobre un camino que este spec no reportó.
4. **Que la base tenga realmente 900 y que el crontab instalado sea
   `deploy/cron.panel`.** Ninguna de las dos es verificable desde la suite. Ver
   §Testing Strategy, «Lo que queda declarado como no verificable».

## Hypothesized Root Cause

Los cuatro defectos están localizados y leídos: no hay que buscar dónde están.
Lo que sigue siendo hipótesis es **por qué se escribieron así**, y eso importa
porque dos de los cuatro tienen la misma causa de fondo y el arreglo tiene que
atacarla o vuelve.

1. **Un número que tiene que estar relacionado con otro, y nada que lo diga**
   (bugs 1 y 2). Es la misma causa dos veces:
   - `ads_frescura_umbral_segundos` en `settings` y `*/15` en `deploy/cron.panel`
     son 900 los dos, y su igualdad no está escrita en ningún lado. El 900 del
     código además está copiado en cuatro archivos (`lib/ads/acciones.ts:544`,
     `app/api/data/ads/route.ts:301`, `app/(panel)/anuncios/page.tsx:223`,
     `app/(panel)/anuncios/GestorAnuncios.tsx:112`) más el seed de la migración
     025. No son dos números en dos archivos: son cinco copias y un período.
   - `AbortSignal.timeout(60_000)` en el cliente y los dos `30_000` de
     `lib/ads/meta.ts:247` y `:291` tienen que cumplir una desigualdad, y esa
     desigualdad no está escrita en ningún lado tampoco.
   El arreglo de forma es el mismo para los dos: la relación va a un módulo y un
   test la verifica. Sin eso, cualquier número que se elija hoy vuelve a
   desincronizarse.

2. **La asimetría entre lecturas y escrituras** (bug 2). En el mismo archivo,
   `leerFilas` (`GestorAnuncios.tsx:570`) tiene un `AbortController` con
   `timeoutMs` explícito y sus dos llamadores le pasan plazo (30 s y 60 s), y el
   `pedir` del toggle (`:1152`) es `fetch(url, init)` pelado. La hipótesis: la
   task que extrajo `ejecutarToggle` movió la lógica afuera del componente para
   poder testearla e inyectó `pedir` como punto de costura, y el plazo quedó del
   lado del llamador —que no lo puso— en lugar de dentro de la función que sí
   sabe cuántos objetos manda.

3. **`effective_status` parece alcanzar y no alcanza** (bug 3). El repo ya se
   tropezó con esto y lo dejó escrito dos veces (`previsualizacion.ts:184` y el
   comentario del subselect de `leerObjetos`): Meta resuelve `effective_status`
   con el estado propio antes que con el del padre. La hipótesis de por qué el
   control quedó cableado a `status` es más simple: `status` es lo que el toggle
   ESCRIBE, y usar el mismo campo para dibujar es lo que hace coherente el
   control. Eso es correcto y hay que conservarlo (3.6); lo que falta es que la
   entrega sea un segundo dato, no que la posición cambie de fuente.

4. **Un best-effort que quedó con `await`** (bug 4). El comentario de
   `refrescarJerarquia` declara la operación prescindible y su `catch {}` se come
   el error a propósito, así que la intención era que no bloqueara. La hipótesis
   de por qué quedó con `await`: el cliente necesitaba que el refetch trajera el
   dato de Meta y no el del cron, y el `await` era la forma más corta de
   garantizarlo. El comentario de `ejecutarToggle` lo dice de frente. O sea que el
   `await` no está por descuido: está sosteniendo una garantía del cliente, y
   sacarlo sin reemplazar esa garantía produce la regresión de 1.19.

5. **`synced_at` como marca de «todo esto es fresco»** (bugs 1 y 4). Se escribe al
   inicio de la transacción de `escribirCuenta`, después de todas las lecturas a
   Meta, y `refrescarJerarquia` lo pone en `now()` cuando refresca UN objeto. Es
   una marca de frescura de la FILA ENTERA, y las dos tandas que la tocan tienen
   que decidir qué significa cuando sólo se confirmó un campo. La tanda C lo
   resuelve no tocándola (decisión C2).

## Correctness Properties

Ocho propiedades, en pares: una de Bug_Condition y una de Preservation por tanda.
El par de cada tanda es lo único que hace falta para shippearla sola.

Property 1: Bug Condition - Umbral con margen contra el período del cron

_For any_ par (umbral, período) con `período > 0` y `umbral >= período`, y para
todo `synced_at` legible con `desaparecido_at` nulo: un objeto sincronizado en la
última corrida sana —edad `<= período + duraciónDeLaCorrida`— NO dispara la
relectura, Y un objeto que se perdió al menos una corrida —edad `>= 2 × período`—
SÍ la dispara. Las dos mitades juntas: el margen tiene una cota inferior (absorber
la corrida) y una cota superior (`margen < período`, o una corrida perdida dejaría
de disparar), y `Margen_Relectura` está dentro de las dos para todo período.

**Validates: Requirements 2.1, 2.2, 2.4**

Property 2: Preservation - «No sé de cuándo es este dato» sigue releyendo

_For any_ objeto con `desaparecido_at` no nulo, con `synced_at` nulo o con
`synced_at` ilegible, y para todo umbral y todo margen: `causaDeRelectura` devuelve
la misma causa que devuelve hoy (`'desaparecida'` para el primero, `'vieja'` para
los otros dos), y el resto de `relecturaSelectiva` —secuencial, tope 10,
presupuesto de 4 s, no bloquea la acción, deja el detalle anotado— produce
exactamente el mismo resultado que la versión sin margen.

**Validates: Requirements 3.15, 3.16**

Property 3: Bug Condition - El plazo del cliente cubre el peor caso del servidor

_For any_ cantidad de objetos `n >= 1` y para el camino de fila (`n = 1`) y el de
lote: `Plazo_Cliente(n) > Peor_Caso_Servidor(n)`, donde el peor caso es la suma de
los timeouts de las llamadas a Meta que el camino confirmado hace de verdad. La
desigualdad vale en los dos mundos —con y sin `refrescarJerarquia` en el camino
crítico— porque los dos lados salen de la misma suma.

**Validates: Requirements 2.5, 2.7, 2.8**

Property 4: Preservation - El plazo vencido es indeterminado y nunca un fallo

_For any_ desenlace del POST del toggle —incluido el aborto por plazo vencido— la
fila vuelve a `statusPrevio` sólo si todavía muestra el valor pintado, el id se
libera de `enVuelo`, hay un aviso no vacío, y el aviso del aborto NO afirma que el
cambio no ocurrió: dice que el resultado se define cuando corra la reconciliación,
con el mismo criterio con el que `enviar` clasifica su propio timeout. La reversión
se sigue decidiendo con `aplicado` y no con la nulidad del aviso.

**Validates: Requirements 2.6, 3.1, 3.2, 3.3, 3.4, 3.11**

Property 5: Bug Condition - El control distingue la entrega sin cambiar de posición

_For any_ par (`status`, `effective_status`) que dibuje interruptor: cuando
`effective_status` es `CAMPAIGN_PAUSED` o `ADSET_PAUSED`, el dibujo trae una
Senal_Entrega de antepasado apagado que nombra al antepasado; en todo otro caso
trae `sin_senal`. Y en los dos casos `encendido` es exactamente
`status === 'ACTIVE'`.

**Validates: Requirements 2.9, 2.10, 2.12**

Property 6: Preservation - Coherencia y accionabilidad del interruptor

_For any_ par (`status`, `effective_status`), incluidos `null`, `''`, minúsculas y
valores desconocidos: la fila dibujada apagada pide `activate` y la dibujada
encendida pide `pause`; después de una acción confirmada el interruptor queda
accionable en la otra dirección; la fila que dibuja badge no tiene `encendido` ni
Senal_Entrega y su texto nunca queda vacío; y `dibujoDeEstado(f).encendido` no
cambia al variar `effective_status` entre dos valores que los dos dibujen
interruptor. Es la Property 1 de `toggleEstado.test.ts` conservada sin aflojarse,
más la mitad de ortogonalidad que el tercer estado hace necesaria.

**Validates: Requirements 3.6, 3.7, 3.10, 3.17**

Property 7: Bug Condition - La respuesta no espera la relectura, y el refetch no retrocede

_For any_ `pause`/`activate` que Meta confirma: la respuesta del
`Endpoint_Acciones` sale sin esperar a `fetchObjeto` —verificable haciendo que la
relectura tarde más que su propio timeout y comprobando que la respuesta llega
igual— Y la base ya tiene el `status` confirmado cuando la respuesta sale, así que
un refetch inmediato del cliente devuelve ese `status` y no el anterior. El
interruptor no vuelve a su posición previa en ningún instante.

**Validates: Requirements 2.13, 2.14**

Property 8: Preservation - El pintado, la reversión y la marca de desaparición

_For any_ `pause`/`activate` confirmado: la fila de `ad_actions` se abrió antes del
POST y quedó `confirmado`; `conservarPintadoEnVuelo` conserva el `status` en
pantalla de los ids en vuelo; y `desaparecido_at` se limpia si y sólo si una
relectura trajo la fila —nunca por la escritura sola—, con el mismo `UPDATE` y el
mismo `catch {}` de hoy, ejecutado después de la respuesta en lugar de antes.

**Validates: Requirements 3.9, 3.12, 2.15**

## Fix Implementation

### Tanda A — el margen del umbral de frescura (2.1 a 2.4)

#### A1. Son dos preguntas distintas sobre el mismo número, y sólo una lleva margen

`ads_frescura_umbral_segundos` tiene hoy dos consumidores que le preguntan cosas
distintas:

- **La Marca_Frescura de la tabla** (`frescuraDeFila` en `celdas.tsx:129`, vía
  `/api/data/ads` y `page.tsx`): «¿este dato se le tiene que ver viejo a una
  persona?». Su borde está documentado y testeado: es `>` y no `>=` porque «una
  fila con exactamente `umbralSegundos` de antigüedad todavía está al día», y un
  umbral no finito deja todo en `al_dia` para no marcar 505 filas por una fila de
  `settings` corrupta.
- **La relectura del preflight** (`causaDeRelectura` en `acciones.ts:835`): «¿este
  dato alcanza para decidir una escritura, o hay que ir a Meta?».

**El margen va sólo en la segunda.** Metérselo a la primera movería el borde de la
marca de 900 a 1350 s, que es un cambio de producto que nadie pidió y que rompe la
semántica documentada de R3.1. Por eso el arreglo NO cambia el valor de `settings`
ni `frescuraDeFila`: agrega una función que deriva el Umbral_Relectura a partir del
Umbral_Frescura, y sólo el preflight la usa.

#### A2. Cuál de las tres opciones de 2.4, y el detalle que invierte el signo

2.4 pide elegir entre tres y registrar el motivo.

**Se elige la primera (margen proporcional al estilo de `pisoDeFrescura`) con el
margen derivado del PERÍODO del cron, no del umbral.** Que es un híbrido con la
tercera: lo que se deriva del período no es el umbral, es el margen.

**El detalle que hay que escribir porque copiar el precedente al pie de la letra
empeoraría el bug:** `pisoDeFrescura(ttl) = max(0, ttl − min(10, ttl/4))` **resta**
el margen, porque en `live.ts` la comparación es `edad < piso ⇒ está fresco, no
sincronices`, y bajar el piso hace que el sync se dispare ANTES. Acá la comparación
es la inversa: `edad > umbral ⇒ está viejo, releé`, y lo que se quiere es que la
relectura se dispare DESPUÉS. Con el margen restado, el Umbral_Relectura quedaría
en 675 s y la relectura se dispararía en más clicks que hoy, no en menos. **El
margen se suma.** Es el mismo razonamiento y el signo opuesto, y ésa es la única
parte del precedente que no se copia.

```pascal
// lib/ads/frescura.ts (nuevo)

CONST PERIODO_SYNC_JERARQUIA_SEGUNDOS = 900   // espejo de deploy/cron.panel:113
CONST UMBRAL_FRESCURA_DEFAULT_SEGUNDOS = 900  // el default que hoy está en 4 archivos

FUNCTION margenDeRelectura(periodoSegundos)
  // Proporcional, como pisoDeFrescura: un margen fijo no sirve para todo período.
  // La mitad del período, que está estrictamente dentro de las dos cotas:
  //   cota inferior  → tiene que absorber la duración de la corrida + el jitter
  //   cota superior  → tiene que ser MENOR que el período, o una corrida perdida
  //                    (edad ≈ 2 × período) dejaría de disparar la relectura y se
  //                    perdería 2.2, que es la razón por la que la relectura existe
  RETURN periodoSegundos / 2
END FUNCTION

FUNCTION umbralDeRelectura(umbralSegundos, periodoSegundos)
  RETURN umbralSegundos + margenDeRelectura(periodoSegundos)
END FUNCTION
```

Con 900 y 900: margen 450 s, Umbral_Relectura **1350 s**. Verificación de las dos
cotas con esos números:

- Corrida sana: la edad recorre `[0, 900 + duración]`. Para que un objeto sano
  cruce 1350, la corrida tendría que tardar más de 450 s (7,5 min). Una corrida es
  una llamada por cuenta y por nivel; `deploy/cron.panel:113` la declara barata.
  **No medido** (ver §Testing Strategy).
- Corrida perdida: al siguiente tick la edad es ≈ 1800 > 1350, así que la relectura
  se dispara. En general `2 × período > período + margen ⟺ margen < período`, que es
  la cota superior de arriba y lo que hace que 2.1 y 2.2 sean compatibles en lugar
  de estar en tensión.

**Las otras dos opciones, y por qué no.**

- *Subir el Umbral_Frescura a un múltiplo del período* (o sea cambiar el valor de
  `settings` a 1800): mueve el borde de la Marca_Frescura junto con el de la
  relectura, que es lo que A1 dice que no hay que hacer. Y **no arregla 1.4**:
  siguen siendo dos números en dos archivos sin nada que los relacione.
- *Derivar el Umbral_Frescura del período*: la app no puede leer el crontab en
  runtime. `deploy/cron.panel` es un archivo que se instala en el host con
  `crontab -e`, no una fuente que el proceso lea, y parsear sintaxis de cron en
  runtime para calcular un umbral es más máquina de la que el problema pide.
  Además borraría la perilla de `settings` que tres consumidores ya leen para la
  marca visual. Lo que sí se conserva de esta opción es su espíritu: **la relación
  está derivada** —el margen sale del período— y el período vive en código.

**Límite declarado:** si alguien pone `ads_frescura_umbral_segundos` por DEBAJO del
período, el margen no lo rescata: con umbral 60 el Umbral_Relectura queda en 510 s,
menor que el período, y la relectura se dispara en la mayoría de los clicks. Se
evaluó usar `max(umbral, período) + margen` para taparlo y **se descartó**: haría
que el preflight ignore en silencio un valor que un operador puso a propósito, y no
hay ninguna evidencia de que alguien lo haya bajado. Queda como límite escrito, no
como defensa silenciosa.

#### A3. Dónde vive la relación y qué la hace fallar sin que nadie mire (2.3)

Tres piezas, y la tercera es la que contesta la pregunta que 2.3 hace de verdad.

1. **Una constante con el período**, `PERIODO_SYNC_JERARQUIA_SEGUNDOS`, declarada
   como espejo de `deploy/cron.panel:113`. Que sea un espejo y no la fuente es
   inevitable: la fuente es el crontab del host.
2. **Un test que lee `deploy/cron.panel`**, busca la línea de
   `sync-ads-jerarquia.ts`, traduce su schedule a segundos y lo compara con la
   constante. Es la verificación ejecutable que 2.3 pide: cambiar `*/15` por
   `*/30` sin tocar el código **rompe la suite**. Ningún test del repo lee todavía
   `deploy/`, así que esto sienta un precedente; es un `readFileSync` en un test de
   entorno node, sin red y sin CLI.
3. **La property sobre TODO par (umbral, período)**, que es lo que cubre el hueco
   que el test del punto 2 no cubre. **El valor efectivo del umbral viene de
   `settings` en runtime, no del default del código, así que un test contra 900 no
   dice nada de una base con otro valor.** La property no compara contra 900:
   cuantifica sobre todos los pares y verifica las dos cotas, así que vale para
   cualquier valor que la base tenga. Es la razón por la que acá una property vale
   más que unos casos.

De paso, el default 900 deja de estar copiado en cuatro archivos y pasa a
importarse de `lib/ads/frescura.ts`. Es un cambio mecánico y sin comportamiento
—los cuatro valen 900 hoy— y lo que compra es que la próxima vez sea un solo lugar.

El cambio en `causaDeRelectura` es de una línea:

```pascal
// antes
IF edad = NULL OR edad > umbralSegundos THEN RETURN 'vieja'
// después
IF edad = NULL OR edad > umbralDeRelectura(umbralSegundos, PERIODO_SYNC_JERARQUIA_SEGUNDOS) THEN RETURN 'vieja'
```

La rama de `desaparecidoAt` queda arriba y sin tocar, y el `edad === null` sigue
cortocircuitando antes de la comparación: 3.15 se preserva por la forma del código.

### Tanda D — los plazos del POST de acciones (2.5 a 2.8)

#### D1. Un módulo con la suma, y los dos plazos derivados de ella

Son dos cambios distintos, como dice el reporte: la fila no tiene plazo y el lote
tiene un número equivocado. Los dos salen de la misma función porque el número
correcto depende de la cantidad de objetos.

```pascal
// lib/ads/plazos.ts (nuevo). Módulo de constantes puro: sin imports de servidor,
// porque lo importan `lib/ads/meta.ts` (server) y `GestorAnuncios.tsx` (client).

CONST PLAZO_META_ESCRITURA_MS = 30_000   // el AbortSignal.timeout de `enviar` (meta.ts:291)
CONST PLAZO_META_LECTURA_MS   = 30_000   // el de `pedir` (meta.ts:247), que usa fetchObjeto
CONST PRESUPUESTO_RELECTURA_MS = 4_000   // el de la relectura selectiva, para el LOTE ENTERO
CONST HOLGURA_CLIENTE_MS = 10_000        // preflight, base, red y el resto sin deadline

// Cuántas llamadas a Meta hace el camino confirmado, POR OBJETO.
// La relectura selectiva NO va acá: su presupuesto es del lote entero, no por
// objeto (`limite` se calcula una vez antes del loop en `relecturaSelectiva`).
FUNCTION peorCasoEstadoMs(n)
  INPUT: n = cantidad de objetos del pedido
  porObjeto ← PLAZO_META_ESCRITURA_MS
            + (refrescoEnCaminoCritico() ? PLAZO_META_LECTURA_MS : 0)
  RETURN PRESUPUESTO_RELECTURA_MS + n × porObjeto
END FUNCTION

FUNCTION plazoClienteEstadoMs(n)
  RETURN peorCasoEstadoMs(n) + HOLGURA_CLIENTE_MS
END FUNCTION
```

`refrescoEnCaminoCritico()` es el único punto donde el acoplamiento C↔D vive, y la
tanda C lo borra: cuando `refrescarJerarquia` sale del `await`, el término
desaparece de la suma en el mismo commit. Lo que impide que quede mintiendo no es un
comentario: es la Property 7, que prueba contra el route que la respuesta no espera
la relectura.

**Los dos `30_000` de `lib/ads/meta.ts` pasan a nombrarse desde estas constantes.**
El valor no cambia —siguen siendo 30_000— así que es un refactor sin comportamiento,
y es lo que hace que la desigualdad de 2.8 se verifique contra el número que las
llamadas usan de verdad y no contra una copia. Si alguien baja el timeout de
`enviar`, el plazo del cliente baja con él.

#### D2. Los números, y la consecuencia de que el plazo crezca con n

| Pedido | Peor caso servidor | Plazo cliente | Hoy |
|---|---|---|---|
| Fila, 1 objeto, **pre-C** | 64 s | **74 s** | sin plazo |
| Fila, 1 objeto, **post-C** | 34 s | **44 s** | sin plazo |
| Lote de 1, post-C | 34 s | 44 s | 60 s (mayor: hoy alcanza por casualidad) |
| Lote de 20, pre-C | 1204 s | 1214 s | 60 s |
| Lote de 20, post-C | 604 s | 614 s | 60 s |
| Lote de `duplicate` | — | **300 s, sin cambio** (3.14) | 300 s |

**Consecuencia declarada:** el plazo crece linealmente con la cantidad de objetos y
para un lote grande llega a decenas de minutos. Eso **no es un objetivo de UX, es un
piso que impone 2.7**: un plazo menor que el peor caso convierte pedidos que estaban
por confirmarse en desenlaces indeterminados, y 2.7 dice explícitamente que eso es
peor que la espera. Lo que baja la espera es la tanda C (parte el peor caso por
objeto casi al medio) y lo que la hace legible es la señal de «en curso» de 2.15
(decisión C4). Se evaluó poner un techo al plazo —los mismos 300 s de `duplicate`—
y **se descartó**: con 300 s, todo lote de más de 5 objetos volvería a violar 2.7.

**Cota, no medición.** `Peor_Caso_Servidor` suma los timeouts de las llamadas a
Meta. El preflight, las consultas a la base, `abrirAccion`/`cerrarAccion` y la red
no tienen deadline, así que el request puede pasarse de la cota si Postgres se
arrastra. `HOLGURA_CLIENTE_MS` es lo que se le reserva a eso, y es una estimación:
no hay filas de producción con tiempos reales (el bugfix lo declara). Por eso 2.6
existe y no es opcional: el plazo puede vencerse sobre un pedido que iba a
confirmarse, y el desenlace tiene que ser indeterminado.

#### D3. Dónde entra el plazo y qué dice el aviso

**El plazo entra en `ejecutarToggle`**, no en el `pedir` del componente. Es la
función que sabe que manda un objeto, y es la que está testeada sin render: si el
plazo lo pusiera el `pedir: (url, init) => fetch(url, init)` de la línea 1152, el
número quedaría en la parte del archivo que ningún test puede tocar. El `init` que
`ejecutarToggle` arma lleva `signal: AbortSignal.timeout(plazoClienteEstadoMs(1))`,
y el `pedir` del componente lo pasa tal cual. El `pedir` del test lo ignora, y de
paso puede afirmar que llegó.

**El desenlace del vencimiento no necesita código nuevo**: un abort cae en el
`catch` que ya existe, que ya revierte con la guarda condicional, ya avisa y ya
libera el id en el `finally`. Lo único que cambia es **el texto**, por dos razones:

- Hoy el aviso interpola `e.message`, y el de un `AbortSignal.timeout` es
  `The operation was aborted due to timeout`: una frase en inglés en un aviso en
  castellano, que además no dice cuánto se esperó.
- El vencimiento del plazo y un error de red son dos hechos distintos para el
  usuario aunque el desenlace sea el mismo.

Se agrega una función pura y exportada —el mismo patrón que `accionDeToggle` y
`statusOptimista`— que traduce el error a texto:

```pascal
FUNCTION textoDeFalloDeToggle(error, plazoMs)
  IF esAbortoPorPlazo(error) THEN
    RETURN 'El cambio de estado no confirmó en <plazo> segundos. La fila quedó como
            estaba; si el pedido llegó a Meta, el resultado se define cuando corra
            la reconciliación.'
  RETURN 'El cambio de estado no se pudo completar: <error>. La fila quedó como
          estaba; si el pedido llegó a Meta, el resultado se define cuando corra la
          reconciliación.'
END FUNCTION
```

La segunda oración es **textual** en las dos ramas: es la que 2.6 pide y la que el
test de red ya verifica buscando la palabra «reconciliación». `esAbortoPorPlazo` mira
`error.name` (`TimeoutError` en Node/undici, `AbortError` en algunos navegadores) y
cae al segundo texto cuando no reconoce nada, que es el desenlace seguro: decir
menos, no afirmar más.

**En el lote sólo cambia el número.** Su `catch` ya conserva la ambigüedad («los
resultados sin confirmar se definen cuando corra la reconciliación») y ya vacía las
filas en proceso. `AbortSignal.timeout(accion === 'duplicate' ? 300_000 : 60_000)`
pasa a `AbortSignal.timeout(accion === 'duplicate' ? 300_000 : plazoClienteEstadoMs(ids.length))`
para `pause`/`activate`. Las otras acciones no `duplicate` quedan en 60 s: ver
§Alcance, punto 2.

### Tanda B — el tercer estado y la navegación (2.9 a 2.12)

Las dos decisiones de producto ya están cerradas por el bugfix y no se rediscuten:
tercer estado visual **en el control** (no dibujarlo apagado, no delegar al badge), y
**navegación** a la campaña (no cascada, no bloqueo). Acá está el cómo.

#### B1. La unión discriminada se extiende, no se convierte en un par de booleanos

`DibujoEstado` es hoy una unión y su comentario dice por qué: la rama `badge` **no
lleva `encendido`**, así que «togglear una fila que dibuja un badge» es imposible por
tipo y no por cuidado del llamador. El tercer estado se suma respetando ese criterio:
es un estado DEL INTERRUPTOR, así que vive sólo en la rama del interruptor.

```pascal
// app/(panel)/anuncios/celdas.tsx

// Lo que `effective_status` permite AFIRMAR sobre la entrega de una fila que dibuja
// interruptor. Dos casos y ninguno se llama 'entrega': `sin_senal` es «Meta no dice
// que un antepasado lo tenga sin entregar», que NO es «entrega» (un
// PENDING_BILLING_INFO tampoco entrega y cae acá). Nombrarlo 'entrega' afirmaría
// algo que este dato no alcanza para afirmar.
TYPE SenalEntrega =
  | { estado: 'sin_senal' }
  | { estado: 'antepasado_apagado', antepasado: 'campaign' | 'adset' }

TYPE DibujoEstado =
  | { control: 'interruptor', encendido: boolean, entrega: SenalEntrega }
  | { control: 'badge', texto: string }

FUNCTION dibujoDeEstado(fila)
  IF esNoToggleable(fila.status) OR esNoToggleable(fila.effectiveStatus) THEN
    RETURN { control: 'badge', texto: ... }        // sin cambios
  RETURN {
    control: 'interruptor',
    encendido: fila.status = 'ACTIVE',             // LA MISMA comparación, intacta
    entrega: senalDeEntrega(fila.effectiveStatus), // dato adicional y ortogonal
  }
END FUNCTION

FUNCTION senalDeEntrega(effectiveStatus)
  IF effectiveStatus = 'CAMPAIGN_PAUSED' THEN RETURN { estado: 'antepasado_apagado', antepasado: 'campaign' }
  IF effectiveStatus = 'ADSET_PAUSED'    THEN RETURN { estado: 'antepasado_apagado', antepasado: 'adset' }
  RETURN { estado: 'sin_senal' }
END FUNCTION
```

`senalDeEntrega` **no mira `status`**. Ésa es la ortogonalidad que 2.10 pide, dicha en
la firma: la posición sale de `status` y la señal sale de `effective_status`, y
ninguna función ve las dos cosas a la vez salvo `dibujoDeEstado`, que las junta sin
mezclarlas. La Property 6 lo verifica variando `effective_status` con `status` fijo.

#### B2. El tercer estado se limita a lo que `effective_status` puede afirmar

Ésta es la decisión que el reparto 92/67/10 obliga a tomar, y se toma del lado
angosto: **el tercer estado se dibuja sólo para las filas cuyo `effective_status`
dice `CAMPAIGN_PAUSED` o `ADSET_PAUSED`.** O sea los 92, que son exactamente el
defecto de 1.10.

**Por qué alcanza.** El defecto es un interruptor **encendido** sobre algo que no
entrega. Para una fila `PAUSED` bajo campaña `PAUSED` el interruptor está apagado y
el objeto no entrega: el control no miente, así que no hay tercer estado que dibujar.
Lo que le falta a esa fila es saber que activarla no va a hacerla entregar, y eso ya
lo dice la advertencia del servidor al activar, que sí tiene el `status` del padre
(`leerObjetos` lo trae en `statusCampania`/`statusConjunto`).

**Lo que se descartó: llevar el `status` del padre a la fila.** Sería la otra salida,
y haría alcanzable el tercer estado para los 67. No entra, y el costo es la razón:
`MetricasObjeto` tiene sus campos declarados **obligatorios y `| null` a propósito**
—«el compilador obliga a `filaDesdeRow` a poblarlos»— así que sumar `campaignStatus`
toca el tipo, la query de `lib/queries/ads.ts` (que ya resuelve tres niveles con un
`UNION ALL` con las filas de sólo gasto, donde el padre puede no existir), el endpoint
de datos, y **la entrada del motor de reglas**, que comparte `MetricasObjeto` y está
apagado y forzado a dry-run (3.18). Es un cambio de contrato de datos para mejorar la
señal de 67 filas cuyo control hoy no miente. **Queda declarado como la salida
disponible si alguien decide después que los 67 la necesitan**, con esa lista de
touchpoints como presupuesto.

**Consecuencia que queda escrita:** para una fila `ACTIVE` con
`effective_status = 'PENDING_BILLING_INFO'` —o cualquier otro efectivo que no sea una
pausa de antepasado— el interruptor sigue verde y sólo aparece el badge que ya
aparece hoy (3.17). No entrega tampoco, y la señal no lo cubre. Es una decisión de
alcance, no un olvido: 2.9 y 2.12 hablan de un antepasado apagado y de navegar a él,
y para un problema de facturación no hay fila a la que llevar al usuario.

#### B3. El aviso al pausar es OTRO texto, y sólo cuando la escritura hace algo

1.12 sale de que `advertenciaPadreApagado` se suma sólo para `activate`
(`previsualizacion.ts:414`), y el comentario de ahí explica por qué se dejó así:
«pausar algo que ya no entregaba deja al objeto exactamente donde el usuario pidió».
2.11 dice que para el usuario que apaga uno de los 92 eso no alcanza.

**Los dos textos son distintos porque dicen cosas distintas.** Al activar, «no
entrega» es una advertencia sobre el futuro; al pausar, es una aclaración sobre lo
que se está apagando.

- `activate` (**sin cambios**, 3.5 lo congela): «la campaña está pausada: el conjunto
  queda activo pero no entrega hasta que se active la campaña».
- `pause` (**nuevo**): «la campaña está pausada: el conjunto ya no estaba entregando,
  así que pausarlo no cambia la entrega». Nombra al antepasado —lo necesita la
  navegación de B4—, dice el hecho y no promete nada del futuro.
- Para un anuncio, las mismas tres variantes que ya existen (conjunto, campaña, los
  dos), en la forma del pasado.

**Se suma sólo cuando `fila.status === 'ACTIVE'`**, o sea cuando el `pause` escribe de
verdad. Pausar algo que ya está `PAUSED` llega con `motivo: 'ya_esta_en_ese_estado'`
y la aclaración no agrega nada. Con eso el aviso nuevo aparece exactamente sobre los
92 y no sobre los 67, y el «ruido sobre la operación de lote más común» que el
comentario de hoy teme queda acotado a las filas que efectivamente se están
apagando. La asimetría con `activate` —que sí se suma sobre
`ya_esta_en_ese_estado`— tiene motivo propio y sigue valiendo: «ya está activo y
sigue sin entregar» ES el síntoma reportado.

#### B4. La navegación: un link que cambia de nivel con el filtro puesto

El conjunto tiene `campaignId` en la fila. El panel ya tiene el movimiento inverso y
testeado: `bajarNivel` (`GestorAnuncios.tsx:959`) pone el nivel de abajo con el id
como única cascada, escribe la URL y no pasa por la máquina de estados de
`seleccion.ts`. La navegación de 2.12 lo espeja hacia arriba.

**Verificado antes de elegirlo:** el filtro de cascada de `lib/queries/ads.ts` es
`o."campaignId" = ANY($campaignIds)` aplicado en el `WHERE` de afuera, y a nivel
campaña el `SELECT` emite `c.campaign_id AS "campaignId"`. O sea que
`level=campaign&campaignIds=<id>` **ya filtra a esa campaña sin una línea de SQL
nueva**.

Dos cosas hay que cerrar y las dos son visibles:

1. `page.tsx` arma la cascada inicial sólo para `nivelInicial === 'adset'`
   (`campaignIds`) y `'ad'` (`adsetIds`). Sin extenderlo a `'campaign'`, el filtro se
   pierde al recargar o al compartir el link, porque `construirUrl` lo toma del
   estado y no de la URL.
2. `ChipCascada` diría «dentro de 1 campaña» estando en el nivel campaña, que se lee
   raro. Necesita un caso de texto para «la campaña X».

**Alternativas descartadas:**

- *Filtrar por `nombre`*: es substring e insensible a mayúsculas, así que con dos
  campañas de nombres parecidos lleva a la fila equivocada o a dos.
- *Cambiar de nivel y sólo resaltar la fila, sin filtrar*: la tabla está paginada y
  ordenada por gasto, y una campaña pausada sin gasto puede no estar en la página —o
  quedar escondida por `status=active` o por `ocultarSinDatos`. El link llevaría a
  una tabla donde la campaña no se ve.
- *Meter la transición en la máquina de `seleccion.ts`*: no tiene evento para subir y
  agregarlo es más cambio que los dos puntos de arriba. `bajarNivel` tampoco pasa por
  la máquina, así que el precedente ya está.

**Dónde aparece el link.** En las dos superficies, y con dos fuentes de dato
distintas, que es la parte que hay que declarar:

- **En el control**, para las filas con Senal_Entrega de antepasado apagado (los 92):
  el dato es `effective_status` + `campaignId`, los dos en la fila.
- **En el aviso tonal** posterior a la acción, cuando el servidor mandó advertencia
  de padre apagado: ahí el dato es el `status` del padre, que el servidor tiene. Es
  la superficie que cubre a los 67 al activar.

Sigue siendo advertencia y no bloqueo, y no hay cascada: la campaña se activa con su
propio interruptor en su propia fila (3.5, y la decisión de producto de 2.12).

#### B5. El dibujo y la accesibilidad del tercer estado

La posición **no se toca**: `translate-x-4` y `bg` de encendido cuando
`encendido === true`. Lo que cambia con `antepasado_apagado` es el tono de la pista
—de `bg-good-500` a `bg-warn-500`, que existe en `tailwind.config.ts`— más el nombre
accesible y el `title`.

**`aria-checked` sigue siendo booleano y sigue saliendo de `encendido`.** Se evaluó
`aria-checked="mixed"`, que ARIA 1.2 admite en `role="switch"`, y **se descartó**:
`mixed` significa «parcialmente encendido», y acá el interruptor está completamente
encendido —el `status` ES `ACTIVE`—; lo que está apagado es el padre. Decirlo con
`mixed` sería mentirle al lector de pantalla sobre el estado del control que va a
accionar. El tercer estado va en el **nombre accesible** (`aria-label`, que ya se
arma con el nombre del objeto y la acción) y en un `aria-describedby` que apunta al
texto que nombra la campaña y la enlaza.

Consecuencia: para un usuario de lector de pantalla el control sigue anunciándose
como un switch encendido, y el «no entrega» llega por la descripción. Es lo correcto
—el switch refleja el `status` que va a invertir— y es coherente con 3.6.

### Tanda C — `refrescarJerarquia` fuera del camino crítico (2.13 a 2.15)

#### C1. La dependencia de 1.19 se resuelve escribiendo lo que ya sabemos

`refrescarJerarquia` está sosteniendo una garantía del cliente: el comentario de
`ejecutarToggle` dice que el refetch trae lo que Meta confirmó **y no el dato del
cron** porque el route relee antes de responder. Sacar el `await` sin reemplazar esa
garantía produce la regresión de 1.19 —el interruptor volviendo a su posición
anterior por un instante— que es el síntoma que este spec vino a arreglar.

**Se elige la primera de las tres salidas: el `UPDATE` con el valor que ya sabemos.**

Cuando `enviar` devuelve `confirmado`, Meta aceptó `status = campos.status`. Eso no es
una suposición: es lo que Meta confirmó. Escribirlo en la base cuesta un `UPDATE` de
una fila y cero llamadas a Meta, y con eso el refetch del cliente devuelve el valor
confirmado sin que nadie lo haya releído.

```pascal
// app/api/ads/acciones/route.ts, en la rama `r.estado === 'confirmado'`

await cerrarAccion(id, 'confirmado')

// Escritura_Confirmada_Local: el MISMO valor que se le mandó a Meta y que Meta
// confirmó. Se usa `campos.status` y no `after` para que no haya una segunda
// derivación del mismo hecho: `campos` es literalmente lo que salió en el POST.
await escribirStatusConfirmado(d.level, objeto.objectId, campos.status)

// Refresco_Diferido: se dispara y no se espera.
diferir(refrescarJerarquia(d.level, objeto.objectId))

// … la respuesta sale acá
```

**Las otras dos salidas, evaluadas.**

- *Que el route devuelva el estado nuevo y el cliente no dependa del refetch.* No
  agrega nada sobre C1: el cliente **ya** tiene ese valor —es el que pintó
  optimistamente— así que devolverlo sería confirmarle lo que ya dibujó. Y metería un
  segundo camino por el que el `status` de la fila puede cambiar, que es la forma del
  bug original: dos lugares clasificando el mismo hecho. Descartada.
- *Diferir la relectura y aceptar el refetch viejo con una guarda del estilo de
  `conservarPintadoEnVuelo`.* No alcanza, y el mecanismo importa:
  `conservarPintadoEnVuelo` sólo actúa mientras el id está en `enVuelo`, y el
  `refrescar()` del cliente dispara el GET **después** de que el `finally` de
  `ejecutarToggle` sacó el id del set. Para que la guarda cubriera ese refetch habría
  que mantener el id en `enVuelo` hasta que la lectura vuelva, y eso alarga el tiempo
  en que la fila descarta clicks (3.11 describe esa guarda como «un pedido en vuelo»,
  no «un pedido más una lectura posterior»). Descartada: convierte un problema de
  dato viejo en un control temporalmente muerto.

#### C2. Qué escribe la Escritura_Confirmada_Local, y sobre todo qué NO escribe

`refrescarJerarquia` hace hoy cuatro cosas en un `UPDATE`: `status`,
`effective_status`, presupuestos, `synced_at = now()` y `desaparecido_at = NULL`. La
escritura local hace **una sola**.

- **`status`: sí.** Es lo que Meta confirmó.
- **`effective_status`: no.** No lo sabemos. Pausar un conjunto cambia también el
  efectivo de sus anuncios, y activar uno bajo una campaña pausada lo deja en
  `CAMPAIGN_PAUSED`. Derivarlo exigiría reimplementar la resolución de Meta, y el repo
  ya documentó dos veces que esa resolución es sutil (el estado propio gana sobre el
  del padre). Queda con el valor anterior hasta que el Refresco_Diferido o el cron lo
  actualicen.
- **Presupuestos: no.** La acción de estado no los toca.
- **`synced_at`: no.** Ponerlo en `now()` afirmaría que la fila entera está fresca
  —incluidos el `effective_status` que no actualizamos y los presupuestos— cuando lo
  único que se confirmó es un campo. Es exactamente la clase de frescura falsa que la
  tanda A está arreglando del otro lado.
- **`desaparecido_at`: no.** Ver C3.

**Consecuencias visibles, declaradas:**

1. Después de pausar uno de los 92, la fila queda `status = PAUSED` con
   `effective_status = CAMPAIGN_PAUSED` hasta que el Refresco_Diferido vuelva
   (segundos). En esa ventana el badge de `TablaAds.tsx:254` dice «campaña pausada»
   sobre una fila cuyo propio estado es `PAUSED`. Es un dato atrasado, no una
   afirmación falsa sobre la entrega: no entrega de las dos formas.
2. La fila puede seguir viéndose «vieja» en la Marca_Frescura inmediatamente después
   de una acción, porque `synced_at` no se adelanta. Es honesto: nadie confirmó la
   fila entera contra Meta. Cuando el Refresco_Diferido aterriza, `synced_at` avanza
   como avanza hoy.

#### C3. El diferimiento, y qué pasa con la marca de desaparición

**Cómo se difiere.** Fire-and-forget: `refrescarJerarquia` ya no rechaza nunca —su
`catch {}` se come todo— así que no puede dejar un rejection sin manejar. Y el panel
corre en un proceso Node de vida larga bajo PM2, no en una función serverless que se
apaga cuando la respuesta sale: el trabajo diferido efectivamente corre. **Eso es lo
que hace legítimo este diferimiento acá y no lo haría en una lambda**, y por eso queda
escrito.

Para que siga siendo testeable, el diferimiento pasa por un helper con un registro de
promesas en vuelo a nivel de módulo y una función `esperarRefrescosPendientes()` que
los tests pueden `await`. Sin eso, `route.frescura.test.ts` —que hoy verifica que una
escritura confirmada adelanta el reloj y limpia la marca— pasaría a depender del
timing y se volvería flaky.

**La marca `desaparecido_at` la sigue limpiando SÓLO la relectura, no la escritura.**
Su justificación está escrita y es evidenciaria: «una escritura confirmada seguida de
una relectura que trajo la fila es evidencia directa de que existe», y los dos caminos
que no ven la fila —el `null` y la excepción— dejan la marca intacta **a propósito**,
porque «Meta no nos dio el objeto» es la misma evidencia con la que el sync la PONE.
Si la escritura local limpiara la marca, se estaría limpiando con la mitad de la
evidencia.

Consecuencia: R4.7 pedía limpiar la marca «sin el atraso del cron», y sigue
cumpliéndose, con el atraso del Refresco_Diferido en lugar de cero. Segundos, no 15
minutos. Es un debilitamiento acotado y declarado, y preserva la regla en lugar de
aflojarla.

#### C4. La señal de «en curso» (2.15)

Hoy el único indicio de que el pedido está corriendo es el pintado optimista, que es
indistinguible de un cambio ya confirmado. La señal es: mientras el id está en vuelo,
el interruptor se dibuja con `aria-busy="true"`, atenuado y con `title` de «cambiando
el estado…».

**El problema y su resolución:** `enVueloToggle` es un `useRef` por una razón escrita
—«no se dibuja nada con esto, y un `setState` por click volvería a renderizar la tabla
entera sin necesidad»—. Para dibujar hace falta estado. Se agregan **dos estructuras
con dos trabajos**:

- El `Set` en el ref sigue siendo **la guarda** (3.11) y tiene que ser síncrono: dos
  clicks en el mismo tick no pueden pasar los dos, y un `setState` es asíncrono.
- Un `useState<ReadonlySet<string>>` con los ids que se **dibujan** como en curso.

Y el argumento del comentario original no se pierde, se acota: **el camino del toggle
ya renderiza la tabla entera**, porque el pintado optimista llama a `setData`. El
render que el comentario quería evitar era el de consultar la guarda en cada click
—incluidos los descartados—, y eso sigue saliendo del ref. El estado nuevo agrega un
render al arrancar y uno al terminar, sobre un camino que ya tenía uno de cada.

El set en curso baja a `TablaAds` y de ahí a `ToggleEstado`, que es donde ya llegan
`fila` y `onToggle`.

### Changes Required — archivo por archivo

| Archivo | Tanda | Cambio |
|---|---|---|
| `lib/ads/frescura.ts` | A | **Nuevo.** `PERIODO_SYNC_JERARQUIA_SEGUNDOS`, `UMBRAL_FRESCURA_DEFAULT_SEGUNDOS`, `margenDeRelectura`, `umbralDeRelectura`. Puro, sin imports |
| `lib/ads/acciones.ts` | A | `causaDeRelectura`: la comparación pasa por `umbralDeRelectura`. `topesDeSettings`: el default 900 se importa. `relecturaSelectiva` **sin tocar** |
| `app/api/data/ads/route.ts` | A | el default 900 se importa (mecánico) |
| `app/(panel)/anuncios/page.tsx` | A + B | el default 900 se importa; la cascada inicial se arma también para `nivelInicial === 'campaign'` |
| `lib/ads/plazos.ts` | D | **Nuevo.** Los dos plazos de Meta, `PRESUPUESTO_RELECTURA_MS`, `HOLGURA_CLIENTE_MS`, `peorCasoEstadoMs`, `plazoClienteEstadoMs`. Puro, importable desde cliente y servidor |
| `lib/ads/meta.ts` | D | los dos `AbortSignal.timeout(30_000)` (`:247`, `:291`) pasan a nombrar las constantes. Mismo valor |
| `app/(panel)/anuncios/GestorAnuncios.tsx` | B + C + D | `ejecutarToggle`: `signal` en el `init` + `textoDeFalloDeToggle` (nueva, pura, exportada). `ejecutarLote`: el plazo de `pause`/`activate` sale de `plazoClienteEstadoMs(ids.length)`; `duplicate` sigue en 300 s. Nuevo estado con los ids en curso, junto al ref de la guarda. `subirACampania`, espejo de `bajarNivel`. El default 900 se importa |
| `app/(panel)/anuncios/celdas.tsx` | B + C | `DibujoEstado` gana `entrega` en la rama `interruptor`; `senalDeEntrega` nueva, pura, exportada; `ToggleEstado` dibuja el tercer estado, el `aria-describedby`, el link a la campaña y el estado «en curso». `frescuraDeFila` y `MarcaFrescura` **sin tocar** |
| `app/(panel)/anuncios/TablaAds.tsx` | B + C | pasa el set de ids en curso y el callback de navegación a `ToggleEstado`. El badge de `:254` **sin tocar** (3.17) |
| `app/(panel)/anuncios/ChipCascada.tsx` | B | un caso de texto para la cascada de una campaña en el nivel campaña |
| `lib/ads/previsualizacion.ts` | B1 | `advertenciaPadreApagado` gana la variante de `pause`; el llamador de `:414` deja de filtrar por `activate` y filtra por «`pause` sobre una fila `ACTIVE`». Los textos de `activate` **textuales** (3.5) |
| `app/api/ads/acciones/route.ts` | C | `escribirStatusConfirmado` nueva; `refrescarJerarquia` pasa a diferirse con el helper y `esperarRefrescosPendientes()` para los tests. El cuerpo del `UPDATE` de `refrescarJerarquia` **sin tocar**. Los caminos de `rename` (`:1192`, `:1401`) **sin tocar** |

## Testing Strategy

vitest en node, sin render, con `fast-check` 4.9.0 (ya en devDependencies, usado en 25
archivos). Toda lógica nueva sale como función pura y exportada, que es el patrón que
el repo ya usa «para el test de la Property 1»: `dibujoDeEstado`, `accionDeToggle`,
`statusOptimista` y `filasConEstado` están exportadas por eso.

### Validation Approach

Dos fases y en este orden: primero tests que **fallen** contra el código sin arreglar
—eso confirma que el defecto existe y de paso confirma o refuta la hipótesis de causa—
y después la verificación de que el arreglo funciona y no rompe lo de al lado. Las
cuatro tandas se validan por separado; ninguna espera a otra para tener sus tests.

### Exploratory Bug Condition Checking

**Objetivo**: sacar contraejemplos que demuestren cada disyunto de C ANTES de tocar el
código. Si alguno NO falla, la hipótesis de esa tanda está mal y hay que rehacerla.

**Plan por tanda:**

1. **C₁ (bug 1)**: property sobre pares (umbral, período) con `umbral = período`, y una
   edad en la ventana `(umbral, período + duración]`. Sobre el código de hoy,
   `causaDeRelectura` devuelve `'vieja'` para toda esa ventana. **Falla en el estado
   actual.** Contraejemplo esperado: `synced_at` de hace 901 s con umbral 900 y cron de
   900 → `'vieja'`, o sea una lectura a Meta en el camino crítico para un objeto que el
   cron acaba de confirmar.
2. **C₂ (bug 2)**: dos casos. (a) `ejecutarToggle` con un `pedir` que nunca resuelve:
   sobre el código de hoy la promesa queda colgada para siempre, la fila queda pintada
   y el id queda en `enVuelo`. **Falla** (se verifica con un timeout del test, que es la
   forma de afirmar «esto no termina»). (b) La desigualdad `60_000 > peorCaso(1)`
   evaluada con los timeouts que el código declara: `60_000 > 64_000` es falso.
   **Falla.**
3. **C₃ (bug 3)**: property sobre `(status, effectiveStatus)`: para toda fila con
   `status = 'ACTIVE'` y `effectiveStatus IN ['CAMPAIGN_PAUSED','ADSET_PAUSED']`, el
   dibujo tiene que traer una señal de antepasado apagado. Sobre el código de hoy
   `dibujoDeEstado` devuelve `{ control: 'interruptor', encendido: true }` sin ningún
   campo de entrega. **Falla, y el contraejemplo es el caso de los 92.**
4. **C₄ (bug 4)**: test del route con `fetchObjeto` mockeado para tardar más que su
   propio timeout, midiendo cuánto tarda la respuesta. Sobre el código de hoy la
   respuesta espera. **Falla.** Y el complemento: con la relectura diferida pero sin la
   escritura local, un refetch inmediato devuelve el `status` anterior —el contraejemplo
   de 1.19, que es la regresión que hay que evitar y que conviene ver una vez.

**Contraejemplos esperados y qué refutarían:** si el test de C₁ NO falla, el umbral
efectivo no es el que se cree (habría que revisar si la base tiene otro valor). Si el de
C₄ NO falla, `refrescarJerarquia` no está donde se leyó. Los cuatro están leídos contra
el código, así que una sorpresa acá es información sobre el entorno, no sobre el bug.

### Fix Checking

```
FOR ALL X WHERE isBugCondition(X) DO
  resultado := F'(X)
  ASSERT expectedBehavior(resultado)     // Properties 1, 3, 5 y 7
END FOR
```

Cada tanda cierra su disyunto y ninguna toca los otros tres: A no cambia el dibujo, B no
cambia ningún tiempo, C no cambia ningún plazo del cliente (baja el número que D usa) y
D no cambia nada del servidor.

### Preservation Checking

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)                    // Properties 2, 4, 6 y 8
END FOR
```

Property-based testing para preservación, por lo que dice el propio spec anterior:
preservar es una afirmación universal («para todo input que no cumple C»), y los casos
que rompen esa clase de invariante son justamente los que a nadie se le ocurren. El
generador de `toggleEstado.test.ts` ya está construido para esto —`statusArbitrario`
incluye `null`, `''`, minúsculas, los efectivos y texto libre— y se reusa.

**Metodología de observación primero**, tanda por tanda: se corre el código SIN arreglar
sobre los inputs de ¬C, se anota lo que devuelve, y el test afirma eso. En particular:

- **Tanda A**: `acciones.relectura.test.ts` ya cubre el Objeto_Desaparecido con dato
  fresco, el `fetchObjeto` que tira, el que no devuelve el objeto, el tope de 10, el
  backoff por cuota y el presupuesto agotado: esos seis **tienen que seguir pasando sin
  una línea de cambio**. Los dos casos de 3.15 que **hoy no tienen test** son
  `synced_at` nulo y `synced_at` ilegible —están escritos en el comentario de
  `causaDeRelectura` y verificados por lectura, no por ejecución— y son justo los que el
  margen podría romper, así que la preservación de la tanda A los agrega.
- **Tanda B**: la Property 1 de `toggleEstado.test.ts` es la que más protege y **no se
  afloja**. Concretamente: la tabla `DIRECCIONES` y los `expect(dibujo).toEqual({
  control: 'interruptor', encendido })` van a romper al agregar un campo, y la respuesta
  correcta es **extender la expectativa con el valor esperado de `entrega`**, no cambiar
  a `toMatchObject`. Eso la endurece; `toMatchObject` la aflojaría y dejaría de fijar
  que no hay campos de más.
- **Tanda C**: `route.frescura.test.ts` y `route.discrepancia.test.ts` siguen valiendo;
  el primero pasa a `await esperarRefrescosPendientes()` antes de mirar la base.
- **Tanda D**: el generador `formaArbitraria` de `toggleEstado.test.ts` gana una forma
  `plazo` (un abort) al lado de la forma `red` que ya tiene, y la Property 2 («no hay
  éxito silencioso») la clasifica como no confirmada, igual que la red.

### Unit Tests

- `margenDeRelectura` y `umbralDeRelectura` con los pares del mundo real (900/900) y con
  los degenerados (período 0, umbral 0, umbral menor que el período).
- El test que lee `deploy/cron.panel`, encuentra la línea de `sync-ads-jerarquia.ts` y
  traduce el schedule a segundos: `*/15` → 900. Incluye el caso de que la línea no
  exista, que también tiene que fallar.
- `senalDeEntrega` para los dos efectivos que devuelven señal, para `null`, `''`, y para
  `PENDING_BILLING_INFO` (que devuelve `sin_senal`: la decisión de alcance de B2 queda
  fijada por un test, no por un comentario).
- `textoDeFalloDeToggle`: la rama del plazo nombra el plazo, la rama del error interpola
  el mensaje, y **las dos** terminan con la oración de la reconciliación.
- `advertenciaPadreApagado` para `pause`: los textos de conjunto y de anuncio, y que
  `activate` sigue devolviendo los textos de hoy **carácter por carácter**.
- `peorCasoEstadoMs` y `plazoClienteEstadoMs` para n = 1, 2, 20, y en los dos mundos del
  refresco.
- La navegación: la URL que arma `subirACampania` para una fila de conjunto, y que
  `page.tsx` reconstruye la cascada a partir de esa URL (la ida y vuelta que 2.12
  necesita para que el link sea compartible).

### Property-Based Tests

Las ocho de §Correctness Properties. Las cuatro impares son de Bug_Condition y las
cuatro pares de preservación; el par de cada tanda es el mínimo para shippearla.

Las dos que más cuestan y más pagan:

- **Property 1** cuantifica sobre pares (umbral, período) y **no contra el default 900**,
  que es lo que hace que cubra una base con otro valor. Es la respuesta al hueco de A3.
- **Property 6** es la hermana de la Property 1 de `toggleEstado.test.ts`: agrega que
  `encendido` no cambia al variar `effective_status`, cuantificado sobre los pares que
  los dos dibujen interruptor (el cuantificador importa: `effective_status` sí decide
  interruptor vs badge, así que la ortogonalidad se afirma dentro de la rama del
  interruptor y no fuera).

### Integration Tests

- El route con `fetchObjeto` lento: la respuesta sale sin esperarlo, y la base ya tiene
  el `status` confirmado cuando sale. Es el test que hace verdadera la afirmación del
  módulo de plazos, y por lo tanto el que sostiene el acoplamiento C↔D.
- El route con la relectura diferida que trae la fila: `desaparecido_at` termina en NULL
  y `synced_at` avanza, después de `esperarRefrescosPendientes()`.
- El route con la relectura diferida que NO trae la fila: la marca **queda**, que es la
  regla evidenciaria de C3.
- `pause` sobre un conjunto `ACTIVE` con campaña `PAUSED`: la previa trae el texto nuevo;
  sobre uno `PAUSED`, no lo trae.
- El toggle de punta a punta con el plazo vencido: la fila vuelve a `statusPrevio`, el id
  se libera y el aviso no afirma que el cambio no ocurrió.

### Lo que queda declarado como NO verificable

Se escribe acá porque «pasa el build» no es evidencia de que algo funcione, y estas
cuatro cosas no las cubre ningún test de esta suite:

1. **Que el crontab instalado en el host sea `deploy/cron.panel`.** El test compara la
   constante contra el archivo del repo, no contra `crontab -l`. El propio
   `deploy/cron.panel` ya advierte ese hueco («verificá ANTES que no estés perdiendo
   líneas que estén vivas y no acá»).
2. **Que `ads_frescura_umbral_segundos` valga 900 en la base de producción.** La Property
   1 cubre cualquier valor, pero nadie verifica cuál está puesto. Se puede mirar con una
   consulta a mano; no hay test.
3. **Cuánto tarda una corrida de la jerarquía y cuánto jitter tiene el cron.** Es la
   cota inferior del margen de A2 y está elegida por argumento, no por medición: la base
   local no tiene corridas (`ads_worker_last_tick` en 2026-08-12) y no hay filas de
   producción disponibles. Si una corrida tardara más de 450 s, el margen quedaría corto
   y el síntoma sería el de hoy, más raro.
4. **Los tiempos reales de los clicks del usuario.** `ad_actions` tiene UNA fila local, y
   no es de la base donde se clickeó. Los plazos de D están calculados sobre los timeouts
   que el código declara, no sobre latencias medidas.
