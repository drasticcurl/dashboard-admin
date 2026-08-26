# Bugfix Requirements Document

## Introduction

El interruptor de estado de la tabla de `/anuncios` fue reportado dos veces por
la misma persona, en dos frases que dicen cosas distintas y las dos son ciertas:

> «todavía no anda el botón de activar o desactivar conjuntos, es psicológico
> básicamente porque no hace nada en Facebook»

> «igualmente creo que ya simplemente tarda un poco y funciona»

Son dos defectos separados y este spec los trata separados, porque tienen
arreglos distintos y ninguno de los dos arregla al otro:

- **Latencia** (bugs 1, 2 y 4). Un click puede tardar más de un minuto sin decir
  nada, y en el camino de una fila puede no terminar nunca porque no tiene plazo.
  Es el «tarda un poco y funciona»: la escritura ocurre, la confirmación llega
  tarde o no llega, y el interruptor queda afirmando un cambio que nadie
  confirmó ni desmintió.
- **Semántica de entrega** (bug 3). El interruptor está cableado a `status`, no a
  si el objeto entrega. Para los **92 de 169 conjuntos** de la cuenta que están
  `status = ACTIVE` con `effective_status = CAMPAIGN_PAUSED`, apagar y prender
  escribe en Meta de verdad, Meta confirma las dos escrituras, y la entrega no
  cambia en ninguna. Es el «psicológico», y es literal: la compuerta es la
  campaña.

**Arreglar la latencia NO arregla los 92 conjuntos**: por más rápido que
conteste, la respuesta correcta para esas filas sigue siendo «se aplicó y no
entrega». **Y arreglar los 92 no baja la espera**: la cadena de tres viajes a
Meta en serie es la misma se entregue o no.

Reparto verificado contra la base, sobre 169 conjuntos:

| `status` | `effective_status` | conjuntos |
|---|---|---|
| ACTIVE | CAMPAIGN_PAUSED | **92** |
| PAUSED | PAUSED | 67 |
| ACTIVE | ACTIVE | 10 |

### Lo que NO es el bug

Casi todo lo que rodea a estos cuatro defectos está bien hecho y con tests. Se
verificó que funciona y no se toca:

- La escritura a Meta es real: `enviar(objectId, { status: 'ACTIVE'|'PAUSED' })`
  hace POST a `graph.facebook.com/{objectId}`, que es la llamada correcta para un
  conjunto.
- La fila de `ad_actions` se abre ANTES del POST (`abrirAccion`), y las omisiones
  también dejan fila.
- Un timeout de la escritura se clasifica `indeterminado` y nunca como éxito,
  porque un POST cortado pudo haberse aplicado igual.
- La reversión del pintado optimista sólo se saltea cuando Meta confirmó
  (`aplicado: true`), y que `aplicado: true` sólo pueda venir de un `confirmado`
  es invariante verificada de `lib/ads/mensajes.ts`.
- El mecanismo de advertencia de padre pausado está completo y llega hasta el
  aviso: `advertenciaPadreApagado` produce «la campaña está pausada: el conjunto
  queda activo pero no entrega hasta que se active la campaña».

El spec anterior `frescura-y-acciones-anuncios` está 43/43 tareas completas.
Nada de lo de acá es una tarea que quedó sin hacer: son defectos nuevos.

### Dos correcciones al reporte inicial

Se verificaron contra el código y cambian el alcance, así que quedan escritas:

1. **El camino de lote SÍ tiene plazo.** `GestorAnuncios.tsx:1312` lleva
   `AbortSignal.timeout(accion === 'duplicate' ? 300_000 : 60_000)`, y su `catch`
   ya conserva la ambigüedad («los resultados sin confirmar se definen cuando
   corra la reconciliación»). El que no tiene plazo es sólo el toggle de UNA
   fila. Lo que sí está mal en el lote es el número: 60 s es MENOR que el peor
   caso del servidor para un solo objeto (~64 s).
2. **`synced_at` no se escribe «cuando el sync termina» por descuido, sino que es
   el instante de inicio de la transacción de `escribirCuenta`**, que corre
   después de TODAS las lecturas a Meta (campañas, conjuntos, anuncios y DSA).
   El efecto es el mismo que describía el reporte —la marca queda al final de las
   lecturas, no al arranque de la corrida— pero el mecanismo importa para elegir
   el arreglo. Y con umbral igual al período, la relectura no se dispara «en la
   mayoría de los clicks» mientras el cron corre bien: se dispara en la ventana
   de cola cuyo ancho es la varianza de la corrida, y a partir de la primera
   corrida que falla o que no trae un objeto, se dispara en TODOS los clicks
   sobre ese objeto hasta que una corrida vuelva a incluirlo.

### Alcance, pendientes y evidencia que no se tiene

Se anotan acá porque acotan el alcance y afectan cómo se verifica el arreglo, no
porque sean bugs:

- Los conteos de este documento salen de la base **local**, donde no corre ningún
  cron: `ads_worker_last_tick` está en 2026-08-12 y el `synced_at` más viejo tiene
  13 días. **Eso no es evidencia de un problema en producción** y este spec no lo
  trata como tal. El reparto 92/67/10 sí es dato real de la cuenta.
- `ad_actions` tiene UNA sola fila en toda la tabla local (un `pause` de campaña
  confirmado, del 2026-08-21). No sirve como evidencia de qué contestó Meta en
  los clicks del usuario: ésta no es la base donde clickeó. Cualquier
  verificación de latencia contra tiempos reales necesita las filas de
  producción.
- `ads_rules_enabled = false` y `ads_rules_force_dry_run = true`: el motor de
  reglas está apagado y forzado a dry-run. Probablemente a propósito. Queda FUERA
  del alcance de este spec, anotado como algo a confirmar.
- Este spec es INDEPENDIENTE de `.kiro/specs/parseo-montos-anuncios/` (ése es
  sobre parseo de números tipeados). No comparten código.

## Bug Analysis

### Current Behavior (Defect)

#### Bug 1 — El umbral de frescura y el período del cron son el mismo número

1.1 CUANDO se toca `pause` o `activate` sobre un objeto cuyo `synced_at` supera
`ads_frescura_umbral_segundos` ENTONCES `causaDeRelectura`
(`lib/ads/acciones.ts:835`) devuelve `'vieja'` con `edad > umbralSegundos`, sin
ningún margen, y `relecturaSelectiva` dispara una lectura extra contra Meta
—hasta 10 objetos, presupuesto de 4 s— en el camino crítico del click.

1.2 CUANDO el cron de la jerarquía corre normalmente ENTONCES el umbral queda
exactamente en la edad máxima que produce una corrida sana:
`ads_frescura_umbral_segundos` vale **900** y el cron es **`*/15`**
(`deploy/cron.panel:113`), o sea 900 s también. La edad de una fila recorre
`[0, 900]` entre corridas, así que cualquier varianza en la duración de la
corrida, cualquier jitter del cron o cualquier objeto que Meta no devolvió cruza
el umbral, cuando el propósito declarado de la relectura es dispararse sólo
cuando el dato local NO alcanza, o sea cuando el sync falló.

1.3 CUANDO una corrida del cron falla, se saltea, o no trae un objeto ENTONCES
ese objeto conserva su `synced_at` viejo (`lib/ads/jerarquia.ts:23`: no se borra
nada y el objeto se queda con su marca vieja) y la edad no vuelve a bajar del
umbral, así que la relectura pasa a dispararse en TODOS los clicks sobre ese
objeto hasta que una corrida vuelva a incluirlo.

1.4 CUANDO alguien cambia el período del cron en `deploy/cron.panel` o el valor
de `ads_frescura_umbral_segundos` en `settings` ENTONCES nada verifica que sigan
coincidiendo: son dos números en dos archivos distintos que tienen que estar
relacionados, el desajuste no produce ningún error, no rompe ningún test y no
aparece en ninguna pantalla.

1.5 CUANDO se compara con `lib/ads/live.ts:71` ENTONCES se ve que el repo YA
resolvió este defecto en otra parte y el mismo razonamiento nunca se aplicó acá:
`pisoDeFrescura(ttl)` le resta al TTL un margen proporcional
(`Math.max(0, ttl - Math.min(10, ttl / 4))`) y su comentario describe el mismo
problema —«`last_sync_at` se escribe cuando el sync TERMINA, no cuando arranca»—
del que este umbral no tiene defensa. `SQL_VIGENTE` de `jerarquia.ts:74` usa un
margen de 10 minutos por la misma razón.

#### Bug 2 — El POST de acciones no tiene plazo en el cliente

1.6 CUANDO se toca el interruptor de una fila ENTONCES el `pedir` que
`GestorAnuncios.tsx:1152` inyecta en `ejecutarToggle` es `fetch(url, init)`
pelado: sin `AbortSignal`, sin deadline y sin ningún presupuesto de espera.

1.7 CUANDO se compara con las lecturas del MISMO archivo ENTONCES aparece la
asimetría: `leerFilas` (`:570`) usa un `AbortController` con `timeoutMs`
explícito y lo documenta como «su propio presupuesto de espera», y los dos
llamadores le pasan plazo (30 s, 60 s). Las lecturas tienen plazo y las
escrituras no.

1.8 CUANDO ese POST no vuelve ENTONCES el `catch` de `ejecutarToggle` —el que
revierte el pintado y avisa— no corre, porque sólo corre si el fetch termina. La
fila se queda mostrando el estado nuevo, el id se queda en `enVuelo` (así que un
segundo click sobre esa fila se descarta por la guarda de doble disparo), y nadie
confirma ni desmiente. Es exactamente cómo se siente un botón que «no hace nada».

1.9 CUANDO un lote de `pause`/`activate` supera los 60 s de
`AbortSignal.timeout` (`:1312`) ENTONCES el cliente abandona un pedido que podía
estar por confirmarse: el servidor puede tardar hasta ~64 s **por un solo
objeto** (4 s de `PRESUPUESTO_RELECTURA_MS` + 30 s del `AbortSignal.timeout` de
`enviar` + 30 s del `fetchObjeto` de `refrescarJerarquia`), y el lote hace eso
por objeto en serie.

#### Bug 3 — El interruptor está cableado a `status`, no a la entrega

1.10 CUANDO un conjunto tiene `status = 'ACTIVE'` y
`effective_status = 'CAMPAIGN_PAUSED'` —92 de 169— ENTONCES `dibujoDeEstado`
(`app/(panel)/anuncios/celdas.tsx:441`) devuelve
`{ control: 'interruptor', encendido: fila.status === 'ACTIVE' }`, así que el
interruptor se dibuja **encendido**, con el tono verde de «activo» y
`aria-checked="true"`, para un conjunto que no entrega.

1.11 CUANDO se clickea uno de esos 92 ENTONCES `accionDeToggle`
(`GestorAnuncios.tsx:274`) decide con el mismo campo, así que el primer click
manda `pause` y el siguiente `activate`; las dos escrituras llegan a Meta, Meta
confirma las dos, `ad_actions` registra dos `confirmado`, y la entrega no cambia
en ninguna de las dos porque la campaña sigue pausada.

1.12 CUANDO se PAUSA uno de esos 92 ENTONCES no hay ninguna advertencia:
`advertenciaPadreApagado` se suma sólo para `activate`
(`lib/ads/previsualizacion.ts:415`). El aviso de que el objeto no entrega llega
en el SEGUNDO click, después de que el usuario ya lo apagó creyendo que lo
estaba apagando de la entrega.

1.13 CUANDO se dibuja la tabla ENTONCES `CAMPAIGN_PAUSED` no está en
`NO_TOGGLEABLE` (`celdas.tsx:26`, que tiene ARCHIVED, DELETED, DISAPPROVED,
WITH_ISSUES, PENDING_REVIEW, IN_PROCESS), así que el interruptor se dibuja y es
clickeable para los 169 conjuntos, sin ninguna diferencia visual entre los 10 que
entregan y los 92 que no.

1.14 CUANDO el panel intenta avisar ENTONCES lo hace en un elemento distinto del
que el usuario mira: `TablaAds.tsx:254` dibuja un badge cuando
`effectiveStatus !== status`, y la advertencia de padre pausado llega al aviso
tonal. El CONTROL sigue reportando `status`. El usuario lee el interruptor, no el
badge.

1.15 CUANDO un conjunto no entrega porque su campaña está pausada ENTONCES el
panel no ofrece ninguna forma de llegar a esa campaña desde la fila del conjunto:
hay que ir a buscarla a mano a la vista de campañas, y activarla es lo único que
haría entregar al conjunto.

#### Bug 4 — Tres viajes a Meta en serie por click

1.16 CUANDO se ejecuta un `pause`/`activate` confirmado ENTONCES el
`Endpoint_Acciones` hace tres viajes a Meta en serie antes de responder:
`relecturaSelectiva` (lectura, 4 s de presupuesto), `enviar` (la escritura, 30 s
de `AbortSignal.timeout`) y `refrescarJerarquia` (`fetchObjeto`, otros 30 s), y
recién entonces contesta.

1.17 CUANDO el cliente recibe esa respuesta ENTONCES hace `entorno.refrescar()`,
que rehace el fetch de TODAS las filas: un cuarto viaje, ahora al endpoint de
datos, después de la espera anterior.

1.18 CUANDO se mira `refrescarJerarquia` ENTONCES está en el camino crítico de la
respuesta (`app/api/ads/acciones/route.ts:577`, justo después de
`cerrarAccion(id, 'confirmado')`) aunque su propio comentario lo declara
best-effort —«la jerarquía se refresca en el próximo sync. La acción ya quedó
confirmada en Meta y en ad_actions»— y su `catch {}` se come el error a
propósito. O sea: el usuario espera 30 s por una operación que el código declara
prescindible.

1.19 CUANDO se intenta sacarlo del camino crítico ENTONCES aparece la dependencia
que hay que resolver y no ignorar: el comentario de `ejecutarToggle` dice
explícitamente que el refetch del cliente trae lo que Meta confirmó Y NO el dato
del cron **porque** el route hace `refrescarJerarquia` antes de responder. Sin
eso, el `refrescar()` del cliente lee el dato viejo y el interruptor puede volver
a su posición anterior por un momento, que es una regresión visible y es justo el
síntoma que este spec vino a arreglar.

### Expected Behavior (Correct)

#### Bug 1 — El umbral tiene que tener margen y no puede ser un número suelto

2.1 CUANDO el objeto se sincronizó en la última corrida sana del cron ENTONCES el
sistema DEBERÁ decidir con el dato local y NO DEBERÁ disparar `relecturaSelectiva`
(responde a 1.1 y 1.2). La comparación DEBERÁ dejar un margen que absorba la
duración de la corrida y el jitter del cron, en lugar de estar exactamente en la
edad máxima que produce una corrida sana.

2.2 CUANDO una corrida del cron falló, se salteó o no trajo el objeto ENTONCES el
sistema DEBERÁ seguir disparando la relectura (responde a 1.3): ése es el caso
para el que la relectura existe y NO se pierde con el margen.

2.3 CUANDO el umbral y el período del cron no coincidan ENTONCES algo DEBERÁ
fallar sin que nadie tenga que acordarse de mirar (responde a 1.4): un test, una
verificación ejecutable o una derivación que haga imposible el desajuste. La
relación entre los dos números DEBERÁ quedar escrita en un solo lugar y ese lugar
DEBERÁ ser verificable.

2.4 CUANDO se elija el mecanismo ENTONCES la decisión DEBERÁ ser explícita entre
las tres opciones y DEBERÁ quedar registrada con su motivo (responde a 1.5):
margen proporcional al estilo de `pisoDeFrescura`, subir el umbral a un múltiplo
del período del cron, o derivar el umbral del período del cron.

#### Bug 2 — La escritura tiene que tener plazo, y el plazo tiene que ser mayor que el del servidor

2.5 CUANDO se toca el interruptor de una fila ENTONCES el POST DEBERÁ salir con
un plazo explícito, igual que las lecturas del mismo archivo (responde a 1.6 y
1.7).

2.6 CUANDO ese plazo se vence ENTONCES el sistema DEBERÁ revertir el pintado
optimista con la misma guarda condicional que hoy, liberar el id de `enVuelo` y
mostrar un aviso que NO afirme que el cambio no ocurrió (responde a 1.8): un POST
cortado pudo haberse aplicado igual, así que el desenlace es indeterminado y el
texto DEBERÁ decir que el resultado se define cuando corra la reconciliación, con
el mismo criterio con el que `enviar` clasifica su propio timeout.

2.7 CUANDO se elija el número del plazo ENTONCES DEBERÁ ser mayor que el peor
caso del servidor para el pedido que se manda (responde a 1.9): con la cadena
actual, ~64 s para un objeto. Un plazo del cliente menor que el del servidor
convierte pedidos que estaban por confirmarse en desenlaces indeterminados, que
es un defecto peor que la espera.

2.8 CUANDO el peor caso del servidor cambie ENTONCES la relación entre los dos
plazos DEBERÁ seguir siendo verificable, en lugar de ser dos constantes que se
desincronizan en silencio (mismo problema de forma que 1.4).

#### Bug 3 — El control tiene que hablar de la entrega, sin romper la invariante que lo hace accionable

2.9 CUANDO un conjunto tiene `status = 'ACTIVE'` y su `effective_status` dice que
un antepasado está apagado ENTONCES el interruptor DEBERÁ distinguirse
visualmente del interruptor de un objeto que sí entrega (responde a 1.10, 1.13 y
1.14). **Decisión de producto que este spec cierra: un tercer estado visual en el
control**, y no dibujarlo apagado ni delegar el aviso al badge.

- **Por qué no dibujarlo apagado**: rompería la invariante que el repo protege
  con la Property 1 de `toggleEstado.test.ts` («la fila que se dibuja apagada
  pide activar»). Un interruptor apagado sobre un conjunto que ya está `ACTIVE`
  pediría `activate`, y el preflight lo omitiría como `ya_esta_en_ese_estado`: el
  control quedaría muerto en una dirección, que es exactamente la clase de bug
  que el spec anterior vino a arreglar.
- **Por qué no alcanza con el badge**: es 1.14. El badge ya existe y ya se dibuja
  para los 92; el usuario lee el control.

2.10 CUANDO se agregue ese tercer estado ENTONCES `encendido` DEBERÁ seguir
saliendo de `fila.status === 'ACTIVE'`, la MISMA comparación que invierte
`accionDeToggle`, y la distinción de entrega DEBERÁ ser un dato ADICIONAL y
ortogonal (responde a la tensión que 2.9 crea con la invariante). El control
DEBERÁ seguir siendo accionable en las dos direcciones para todo valor de
`status`.

2.11 CUANDO se PAUSA un conjunto que no entregaba ENTONCES el sistema DEBERÁ
decirlo en el momento del click y no en el siguiente (responde a 1.12): el
usuario que apaga uno de los 92 DEBERÁ poder saber que lo que apagó no estaba
entregando, antes o al ejecutar, sin tener que prenderlo de nuevo para leer la
advertencia.

2.12 CUANDO un conjunto no entrega porque su campaña está pausada ENTONCES el
panel DEBERÁ ofrecer un camino directo a esa campaña desde la fila del conjunto
(responde a 1.15). **Decisión de producto que este spec cierra: es navegación, no
cascada.** El aviso y el control nombran la campaña y llevan a su fila, donde su
propio interruptor hace la escritura.

- **Por qué no una acción en cascada**: activar una campaña cambia la entrega —y
  el gasto— de todos los conjuntos que tiene debajo, un radio mucho mayor que la
  fila que el usuario tocó, y hoy no hay ninguna previa que muestre ese alcance
  antes de tocar 92 objetos. Una cascada sin esa previa es una escritura a ciegas
  sobre la cuenta entera.
- **Qué NO cambia**: sigue siendo una advertencia y no un bloqueo. Activar un
  conjunto con la campaña pausada es legítimo cuando se está preparando algo para
  prender después, el código ya lo dice y este spec no lo convierte en bloqueo.

#### Bug 4 — La espera tiene que bajar sin devolver el interruptor a su posición anterior

2.13 CUANDO se ejecuta un `pause`/`activate` de una fila ENTONCES el sistema
DEBERÁ responder sin esperar los tres viajes a Meta en serie (responde a 1.16 y
1.18): la lectura que sólo sirve para refrescar la jerarquía NO DEBERÁ estar en
el camino crítico de la respuesta, coherente con que el propio código la declara
best-effort.

2.14 CUANDO `refrescarJerarquia` salga del camino crítico ENTONCES el refetch del
cliente DEBERÁ seguir mostrando lo que Meta confirmó y NO el dato del cron
(responde a 1.19). La dependencia DEBERÁ resolverse explícitamente: el
interruptor NO DEBERÁ volver a su posición anterior ni por un instante después de
una acción confirmada.

2.15 CUANDO el usuario haya esperado ENTONCES DEBERÁ ver alguna señal de que el
pedido está en curso mientras dure (responde a 1.17): hoy el único indicio es el
pintado optimista, que es indistinguible de un cambio ya confirmado.

### Unchanged Behavior (Regression Prevention)

Todo lo que rodea a estos cuatro defectos está verificado con tests y es lo que
se rompe si el arreglo se hace de más. Se enumera porque la mayoría de estas
cláusulas son la razón por la que un arreglo «obvio» de los bugs de arriba está
mal.

3.1 CUANDO un POST a Meta corta por timeout ENTONCES el sistema DEBERÁ SEGUIR
clasificándolo `indeterminado` y nunca como éxito ni como fallo: un POST cortado
pudo haberse aplicado igual y reintentar a ciegas es cómo una subida de
presupuesto se aplica dos veces.

3.2 CUANDO haya que revertir el pintado optimista ENTONCES el sistema DEBERÁ
SEGUIR tocando la fila SÓLO si todavía muestra el valor que se pintó, y DEBERÁ
SEGUIR restaurando `statusPrevio` y no `PAUSED`/`ACTIVE`: la fila pudo llegar con
`status` nulo o con un valor que el cliente no conoce.

3.3 CUANDO el traductor de resultados marque un aviso con `aplicado: true`
ENTONCES ese aviso DEBERÁ SEGUIR pudiendo venir únicamente de un `confirmado`
(invariante de `lib/ads/mensajes.ts`, verificada allá), y `ejecutarToggle` DEBERÁ
SEGUIR decidiendo la reversión con `aplicado` y no con la nulidad del aviso.

3.4 CUANDO un `confirmado` traiga advertencia ENTONCES el sistema DEBERÁ SEGUIR
sin revertir la fila y DEBERÁ SEGUIR pidiendo el refetch: la advertencia habla
del padre, no de que la escritura no haya ocurrido.

3.5 CUANDO se active un objeto con un antepasado pausado ENTONCES la advertencia
DEBERÁ SEGUIR siendo una advertencia y no un bloqueo, con las tres cosas que hoy
dice: que el cambio se aplicó, que el objeto igual no va a entregar, y qué hacer
al respecto.

3.6 CUANDO se dibuje y se toggle cualquier fila ENTONCES `dibujoDeEstado` y
`accionDeToggle` DEBERÁN SEGUIR saliendo de la MISMA comparación
(`status === 'ACTIVE'`) para todo valor de `status`, incluidos `null` y valores
que el cliente no conoce: la fila dibujada apagada pide activar y la dibujada
encendida pide pausar.

3.7 CUANDO una acción confirmada cambie el `status` de una fila ENTONCES el
interruptor DEBERÁ SEGUIR quedando accionable en la otra dirección: nunca de una
sola dirección.

3.8 CUANDO se ejecute `pause` o `activate` ENTONCES el sistema DEBERÁ SEGUIR
escribiendo el campo `status` con POST a `graph.facebook.com/{objectId}`, con los
mismos valores `ACTIVE`/`PAUSED` que hoy. Este spec no cambia qué se le pide a
Meta.

3.9 CUANDO se ejecute cualquier acción ENTONCES la fila de `ad_actions` DEBERÁ
SEGUIR abriéndose ANTES del POST, y las omisiones DEBERÁN SEGUIR dejando fila.

3.10 CUANDO el `status` o el `effective_status` de una fila esté en
`NO_TOGGLEABLE` ENTONCES la celda DEBERÁ SEGUIR dibujando un badge y no un
interruptor, el badge DEBERÁ SEGUIR sin quedar nunca en blanco (`''` cuenta como
ausente), y el tipo DEBERÁ SEGUIR impidiendo derivar una posición de interruptor
de una fila que dibuja badge.

3.11 CUANDO se clickee dos veces la misma fila con un pedido en vuelo ENTONCES la
guarda por id (`enVuelo`) DEBERÁ SEGUIR descartando el segundo, y dos filas
distintas DEBERÁN SEGUIR pudiendo tocarse a la vez.

3.12 CUANDO llegue una respuesta del endpoint de datos mientras un id está en
vuelo ENTONCES `conservarPintadoEnVuelo` DEBERÁ SEGUIR conservando el `status`
que hay en pantalla para ese id.

3.13 CUANDO se dispare una lectura de filas ENTONCES DEBERÁ SEGUIR teniendo su
presupuesto de espera propio y su número de secuencia, y una respuesta vieja
DEBERÁ SEGUIR sin pisar una más nueva.

3.14 CUANDO un lote de `duplicate` corra ENTONCES DEBERÁ SEGUIR con sus 300 s, sus
filas fantasma en ≤2 s y el vaciado completo al responder.

3.15 CUANDO un objeto tenga `desaparecido_at` no nulo, `synced_at` nulo o
`synced_at` ilegible ENTONCES la relectura DEBERÁ SEGUIR disparándose: «no sé de
cuándo es este dato» no es una razón para confiar en él, y el margen del bug 1 no
lo cambia.

3.16 CUANDO la relectura falle, no vuelva dentro de su presupuesto, quede fuera
del tope de 10 objetos o haya un backoff por cuota activo ENTONCES DEBERÁ SEGUIR
sin bloquear la acción, decidiendo con el dato de la base y dejando anotado por
qué no se pudo revalidar. Y DEBERÁ SEGUIR siendo secuencial y no en paralelo.

3.17 CUANDO `effective_status` difiera de `status` ENTONCES el badge de
`TablaAds.tsx` DEBERÁ SEGUIR dibujándose: el tercer estado del interruptor se
suma, no lo reemplaza.

3.18 CUANDO se toque cualquier cosa de este spec ENTONCES el motor de reglas
DEBERÁ SEGUIR apagado y forzado a dry-run (`ads_rules_enabled = false`,
`ads_rules_force_dry_run = true`): está fuera del alcance de este spec y no se
toca. Queda como pendiente a confirmar si ese apagado es intencional.
