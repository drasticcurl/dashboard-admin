# ANUNCIOS — Gestor de campañas de Meta y motor de reglas

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

Extensión del panel que ya corre en `https://panel.hilvanapp.com`. Agrega una sección **Anuncios**
con tres pantallas: el **gestor** (listar campañas, conjuntos y anuncios con la plata real al lado,
pausar, activar, cambiar presupuesto), las **reglas** (automatizar esas mismas acciones según
condiciones sobre las métricas del día) y el **historial** (qué hizo o habría hecho el motor, y por
qué).

La referencia visual y funcional es el gestor de anuncios de Utmify. La diferencia que justifica
construirlo acá en lugar de usar las reglas automatizadas nativas de Meta: **las de Meta solo pueden
mirar los datos de Meta.** Este panel conoce el neto real de cada venta —bruto menos devoluciones,
menos comisiones de pasarela, menos costo de producto, todo congelado en la orden— y Meta no. Una
regla que decide con el neto real es una decisión distinta a una que decide con el `purchase_roas`
que reporta Meta.

**Este módulo escribe en la cuenta publicitaria. Puede gastar plata y puede apagar la facturación.**
Todo lo que sigue está diseñado alrededor de esa frase.

---

## 0. Qué se construye y qué no

**Se construye**

1. La jerarquía de Meta persistida en Postgres (`ad_campaigns` → `ad_sets` → `ads`) con estado y
   presupuesto, sincronizada desde la Marketing API.
2. La escritura hacia Meta: cambiar estado (`ACTIVE`/`PAUSED`) en los tres niveles y presupuesto
   diario en campaña o conjunto.
3. Las métricas por objeto: gasto, ventas, ingresos, neto, ganancia, ROI, ROAS y CPA para cada
   campaña, conjunto y anuncio, cruzando `ad_spend` con `orders` por el id de Meta que viene en los
   UTMs.
4. Un motor de reglas con condiciones sobre esas métricas, acciones sobre esos objetos, modo sombra,
   cooldown, techos, ventana horaria y auditoría completa.
5. Un worker que evalúa cada minuto, con backoff adaptativo contra los límites de la API.
6. Avisos por Telegram, configurables con un script.
7. Las tres pantallas del panel.

**No se construye** (fuera de alcance, explícito para que ningún agente lo invente)

- **Duplicar ni crear** campañas, conjuntos o anuncios. "Duplicar a $25" en los nombres de las reglas
  del usuario significa **subir el presupuesto**, no clonar un objeto (confirmado con el usuario).
  Clonar implica copiar segmentación, creativos y pujas, y es otro módulo.
- Cambios de segmentación, creativos, pujas, objetivos ni nada que no sea estado y presupuesto.
- Archivar ni borrar objetos en Meta. `ARCHIVED` y `DELETED` se **leen** pero no se escriben nunca:
  son irreversibles desde la API y no hay ningún caso de uso que lo pida.
- Otras plataformas. Solo Meta (D-A16).
- Cambios en `lib/ads/sync.ts`, `lib/ads/live.ts`, `lib/queries/sales.ts` ni en ninguna pantalla
  existente. El gasto que hoy alimenta Resumen y Ventas **no se toca**: es un camino que ya funciona.
- Dependencias nuevas de npm (D-A18).

---

## 1. Decisiones cerradas

No hay nada que decidir. Si aparece algo que este documento no resuelve, se anota en §10 y **no se
decide en el código**.

**D-A1 — Se extiende `lib/ads/`, no se crea un módulo nuevo.** Ya existe una integración con la
Marketing API que funciona en producción: `lib/ads/meta.ts` (cliente de lectura con paginación,
timeout y `MetaAdsError`), `lib/ads/sync.ts` (`syncAdSpend` idempotente por upsert), `lib/ads/live.ts`
(refresco en el render con TTL). Todo eso se reusa. Reescribirlo desde cero es tirar el manejo de
errores por cuenta, la paginación y la conversión a EUR congelada, que ya están probados con plata
real.

**D-A2 — Un solo token: `META_ADS_TOKEN`, ahora con `ads_management`.** El usuario confirmó que le
dio el permiso al mismo token que ya usa el panel. **No se agrega una variable nueva.** Pero el
permiso hay que **probarlo antes de construir encima**: leer gasto necesita `ads_read` y escribir
necesita `ads_management`, son permisos distintos y el panel hoy solo demostró el primero. T13 §3
tiene el procedimiento. Si el token no puede escribir, **T13 para** y no arranca ninguna otra task.

**D-A3 — El token va en el header `Authorization: Bearer` en TODAS las llamadas, no sólo en las de
escritura.** El código actual lo pone en el query string (`lib/ads/meta.ts:98` y `:143`).

La versión anterior de esta decisión decía "en la lectura de gasto es tolerable". **Deja de ser
tolerable en el momento exacto en que se le da `ads_management` al mismo token** (D-A2): a partir de
ahí cada URL de lectura transporta una credencial que puede apagar la facturación de la cuenta, y esas
URLs terminan en logs de acceso, en mensajes de error, en trazas y en cualquier proxy del camino.
Separar sólo el POST no baja el privilegio de lo que se filtra: baja el privilegio de nada.

Migrar `pedir()` a header es barato y **no toca `lib/ads/sync.ts`**, porque la firma de
`fetchInsights` no cambia. `lib/ads/meta.ts` es de T13 (§8), así que entra en su alcance.

**La trampa de la paginación, que hay que resolver o el cambio no sirve.** `pedir()` sigue
`paging.next` tal como lo devuelve Meta (`lib/ads/meta.ts:170`), y **esa URL trae el `access_token`
adentro**. Migrar la primera llamada al header y después seguir el cursor verbatim deja el token en la
URL de todas las páginas menos la primera. Las dos salidas válidas:

1. reconstruir la URL: leer `paging.cursors.after` y volver a armar la query sin el token, o
2. parsear `paging.next` y **borrarle el parámetro `access_token`** antes de usarla.

La (2) es menos código y sobrevive a que Meta agregue parámetros al cursor. Cualquiera de las dos, pero
**el test tiene que verificar que ninguna URL que sale de este módulo contiene la cadena
`access_token`**, no que la primera no la contiene.

Y el corolario para los errores: `MetaAdsError` no puede llevar la URL en el mensaje. Hoy no la lleva;
que siga así es parte de esta decisión, no una coincidencia.

**D-A4 — La jerarquía se persiste. `ad_spend` es el consumo, la jerarquía es el inventario.**
`ad_spend` solo tiene filas de objetos que gastaron ese día, y no tiene ni estado ni presupuesto. Un
conjunto pausado ayer no aparece hoy, así que sin la jerarquía no se puede listar ni reactivar
justamente cuando hace falta, y la regla "Activar todas a las 0 horas a ver cómo rinden" es
imposible de implementar.

**D-A5 — Pausar y activar en los tres niveles; presupuesto solo en campaña y conjunto.** En Meta el
presupuesto vive en la campaña (CBO / Advantage campaign budget) o en el conjunto (ABO). **Los
anuncios no tienen presupuesto, nunca.** Una regla de presupuesto con `level='ad'` se rechaza en la
validación —hay un CHECK en la base que lo garantiza— en lugar de fallar contra la API con un error
que no dice eso.

**D-A6 — El presupuesto se guarda y se escribe en unidades mínimas, como entero.** Meta usa céntimos:
`2500` son €25,00. Guardarlo en `numeric(14,2)` fuerza a multiplicar y redondear en cada escritura, y
ese redondeo es donde una regla de "+20%" termina pidiendo €25,004 y el POST falla con un error de
validación que en el log parece un problema de permisos.

**D-A7 — Las definiciones de ROI, ROAS y GANANCIA. Congeladas.**

```
ingresos   = suma de amount_eur de las órdenes aprobadas atribuidas al objeto
devuelto   = suma de amount_eur de las refunded / chargeback
comisiones = suma de commission_amount_eur      (ya congelada en la orden)
costos     = suma de cost_amount_eur            (ya congelada en la orden)
gasto      = suma de spend_eur de ad_spend para ese objeto y ese día

neto     = ingresos − devuelto − comisiones − costos
GANANCIA = neto − gasto
ROAS     = ingresos / gasto      ← bruto, SIN comisiones ni costos
ROI      = neto     / gasto      ← CON comisiones y costos
CPA      = gasto / ventas aprobadas
```

`ROAS` y `ROI` comparten el denominador y se diferencian solo en el numerador. Es exactamente lo que
pidió el usuario: "ROI incluyendo comisiones, ROAS sin incluirlas". Los dos son **múltiplos**, no
porcentajes: `ROI = 1.3` significa que el neto es 1,3 veces el gasto. Los umbrales de las reglas del
usuario (1.1 a 1.3) están en esa escala.

> **Trampa. `lib/queries/sales.ts` ya tiene un campo llamado `roi` y significa OTRA COSA:** ahí es
> `resultado / gasto_total`, con `resultado = neto − ads` y `gasto_total = comisiones + costos + ads`,
> expresado en tanto por uno y capaz de ser negativo. Con esa fórmula, `1.3` sería un 130% de retorno
> sobre el gasto total, que no es lo que las reglas del usuario quieren decir.
> **Ningún archivo de este módulo importa ni replica ese `roi`.** `lib/queries/ads.ts` define el suyo
> con la fórmula de arriba y nadie toca `sales.ts`. Las dos secciones muestran números distintos con
> nombres parecidos, y la UI de Anuncios tiene que aclararlo con un tooltip.

**D-A8 — Las métricas salen de `orders`, atribuidas por el id de Meta en los UTMs.** No de los
`actions`/`purchase_roas` de la Marketing API. Los funnels mandan `{{campaign.name}}|{{campaign.id}}`
en `utm_campaign`, el conjunto en `utm_medium` y el anuncio en `utm_content`, así que el cruce es por
**id exacto** y renombrar una campaña en Meta no parte la serie. La expresión de extracción está en
§4 y verificada en `_verificacion-016.sql` §5.

Consecuencia que hay que mostrar en la UI y no esconder: una venta cuyos UTMs no matchean ningún
objeto **no se pierde**, queda fuera de las métricas por objeto y tiene que aparecer en un contador
visible de "ventas sin atribuir a un anuncio". Es el mismo criterio que D10 del plan original.

**D-A9 — Un porcentaje es un FACTOR sobre el presupuesto actual, no un incremento.**

```
nuevo = actual × (p / 100)

100% → no cambia        250% → 2,5 veces        50% → la mitad
```

Así que "250%" sobre €10,00 son **€25,00**, no €35,00.

**Esto está verificado contra el export real de las reglas del usuario** (`_reglas-utmify.csv`), donde
Utmify guarda el valor como `actionPercentInfo: 2.5` y la UI lo muestra como "250%". La aritmética de
las tres reglas de escalado no deja lugar a dudas: cada techo es exactamente el borde superior de su
condición de presupuesto multiplicado por 2,5.

| Regla | Condición | × 2,5 | Techo configurado |
|---|---|---|---|
| Duplicar a $25 | `budget < €11,00` | €27,50 | €25,00 |
| Duplicar a $75 | `budget < €30,00` | **€75,00** | €75,00 |
| Duplicar a $150 | `spend > €50,00` | — | €150,00 |

Con la lectura de "incremento" (`× (1 + p/100)` = ×3,5) el techo cortaría en todas las corridas y sería
decorativo. Con la de factor, los números cierran al céntimo. **Es el diseño de las reglas, no una
coincidencia.**

Consecuencia para la UI: la etiqueta **no puede decir "aumentar un X%"**, porque en castellano eso se
lee como un incremento. Dice **"escalar al ___% del presupuesto actual"**, con `100%` marcado como "sin
cambio" y el resultado calculado al lado del campo mientras se escribe.

**La dirección la fuerza la base, no la buena fe del formulario.** Con la lectura de factor, un valor
menor a 100 BAJA el presupuesto, así que `budget_increase` con `50` no es "subir poco": parte el
presupuesto al medio cada 15 minutos, y el techo obligatorio no lo frena porque el resultado siempre
queda por debajo. Al revés igual: `budget_decrease` con `250` multiplica por 2,5 una regla que se llama
"bajar". El `CHECK ad_rules_percent_direccion` de la 016 lo rechaza:

| Acción | `action_unit` | `action_value` permitido |
|---|---|---|
| `budget_increase` | `percent` | **> 100** |
| `budget_decrease` | `percent` | **> 0 y < 100** |

La UI lo advierte también, pero la base es la última línea: un `psql` a mano tampoco puede dejar
cargada una regla que hace lo contrario de su nombre.

**D-A9b — `action_unit = 'fixed'` es un incremento en EUR, y EL SIGNO LO PONE LA ACCIÓN.**

```
budget_increase → nuevo = actual + valor
budget_decrease → nuevo = actual − valor
```

`action_value` **siempre es positivo** (lo fuerza el `CHECK ad_rules_presupuesto_completo`), así que la
fórmula no puede escribirse `actual + valor` y confiar en que el valor venga negativo: con eso, una
regla de bajar €1,00 sube €1,00. Es un error de una sola línea que se paga con presupuesto y que no
produce ningún síntoma raro en el log: la acción dice "se bajó" y el importe subió.

Las reglas del usuario no usan `fixed` (`actionFixedCentsInfo` viene vacío en las seis), pero el
formulario lo ofrece y la distinción tiene que quedar clara en la UI: un select con dos opciones que
dicen **"escalar al %"** y **"sumar/restar €"**.

**D-A9c — Hay un techo absoluto del lado servidor, y no lo pone ninguna regla.** El techo por regla
(`ad_rules.budget_max`) protege contra que **esa** regla se desboque. No protege contra un error de
unidades, de moneda, de decimales o de payload: un POST armado a mano contra `/api/ads/acciones` con
`budgetEur: 250000`, o un techo mal tipeado en el formulario, llegaban a Meta tal cual.

Dos filas nuevas de `settings`, aplicadas **en el servidor** por el motor, por las acciones manuales y
por el endpoint en lote, sin excepción:

| Setting | Default | Qué corta |
|---|---|---|
| `ads_max_daily_budget_eur` | `200` | ningún objeto puede quedar con más de este presupuesto diario |
| `ads_max_delta_por_tick_eur` | `300` | cuánto puede sumar el módulo entre TODOS los objetos de un tick |

El segundo cubre el caso que el primero no ve: 80 conjuntos que suben €50 cada uno son €4.000 de
presupuesto diario nuevo en un minuto, y cada uno individualmente estaba dentro del límite.

**Ninguno de los dos se cambia desde `/api/ads/interruptores` ni desde el formulario de reglas.** Si el
mismo endpoint que mueve presupuesto puede levantar su propio techo, no es un techo: es una sugerencia.
Se cambian con un `UPDATE` a mano, y el cambio queda registrado en `ad_actions` como evento de
configuración. El default de €200 es deliberadamente bajo respecto de lo que el negocio podría querer:
subirlo tiene que ser un acto consciente, y la regla «Duplicar a $150» del usuario entra abajo.

Un pedido que pasa el techo **no se recorta en silencio**: se rechaza con `motivo: 'tope_absoluto'` y la
explicación dice cuál era el pedido y cuál el techo. Recortar callado convierte un bug de unidades en
"la regla funciona raro".

**D-A10 — Sólo cuentas en EUR y sólo objetos con presupuesto DIARIO. Y en la zona horaria de la cuenta
de Meta.** Sin toggle de moneda en esta sección: las cuentas facturan en EUR y las reglas comparan
gasto contra ingresos, así que meter ARS al medio agrega una conversión y ningún valor.

**Pero "todo en EUR" era un supuesto, no una restricción, y eso es el problema.** El contrato dice
`dailyBudgetEur` y la UI calcula `budgetEur * 100`, mientras que Meta recibe **unidades mínimas de la
moneda de la cuenta** y `ad_accounts.currency` no está restringida a EUR ni verificada. Con una cuenta
en otra moneda, ese `× 100` escribe un importe equivocado sin ningún error. Y el exponente no siempre es
2: hay monedas donde la unidad mínima es la unidad.

Igual con el modo de presupuesto: T14 infiere que el presupuesto es de campaña si viene `daily_budget`
**o** `lifetime_budget`, pero lo único que el módulo sabe escribir es `setDailyBudget`. Un CBO con
presupuesto total quedaría marcado como editable y cada corrida fallaría contra la API.

Así que la restricción se hace explícita y **se verifica, no se asume**:

- Una cuenta cuyo `ad_accounts.currency` no sea `'EUR'` **no se sincroniza y no se lista**. El script de
  jerarquía la reporta y sigue con las demás.
- Un objeto con `lifetime_budget` y sin `daily_budget` se persiste (hay que verlo en el gestor) pero
  **su presupuesto no es editable** y las reglas de presupuesto lo omiten con
  `motivo: 'presupuesto_lifetime_no_soportado'`. No se convierte de total a diario: eso cambia cómo
  entrega la campaña y nadie lo pidió.
- `MetricasObjeto` lleva `budgetMode` para que la UI y el motor sepan en qué caso están (§4).

Soportar otras monedas o presupuestos totales es otro módulo, y arranca por modelar moneda, unidad
mínima y exponente en serio. Lo que no se puede es inferir la moneda del nombre de un campo que dice
`Eur`.

> **El bug más caro del módulo.** `ad_spend.day` viene en la zona de la **cuenta de Meta**;
> `orders.day` está congelado en la zona del **funnel** y nunca se recalcula. Una venta de las 21:30
> de Buenos Aires es del **día siguiente** en Lisboa. Agrupar por `orders.day` y cruzar contra
> `ad_spend.day` mete esas ventas en el día equivocado, y el ROI del día se calcula contra el gasto
> de otro día. Las métricas por objeto agrupan por
> `(orders.purchased_at AT TIME ZONE ad_accounts.timezone)::date` y **nunca** por `orders.day`.
> Verificado en `_verificacion-016.sql` §6.

**D-A11 — La ventana de evaluación es diaria.** `today` es el default y el único que importa;
`yesterday`, `7d` y `7d_excl_today` existen porque la regla "Activar todas a las 0 horas" del usuario
mira los últimos 7 días excluyendo hoy. No hay ventanas por hora ni móviles.

**D-A12 — Doble interruptor, y todo nace en el lado seguro.** Dos niveles porque resuelven dos
momentos distintos:

| Interruptor | Dónde | Default | Qué hace |
|---|---|---|---|
| `enabled` | por regla | `false` | la regla no se evalúa |
| `dry_run` | por regla | `true` | se evalúa y se registra, no se escribe en Meta |
| `ads_rules_enabled` | `settings`, global | `false` | freno de mano: el worker no hace nada |
| `ads_rules_force_dry_run` | `settings`, global | `true` | todo corre y se registra, nada se escribe |

`ads_rules_force_dry_run` es el que pidió el usuario: deja prender las reglas y mirar un día entero
de decisiones simuladas en el historial antes de darle la llave del presupuesto. Después de
desplegar, **el módulo no toca un euro hasta que alguien entra al panel y cambia los dos a mano.**

**D-A12b — Los cuatro interruptores se cambian DESDE LA WEB. Ninguno es una variable de entorno.**
Pedido explícito del usuario. Los dos globales viven en `settings` y los dos por regla en `ad_rules`,
todos en la base, y **T19 tiene que dar la UI para cambiarlos**: dos switches arriba de la lista de
reglas para los globales, y uno por fila para el `dry_run` de cada regla.

La razón por la que no puede ser un env var, más allá del pedido: cambiar `.env.production` obliga a
`pm2 reload`, y reiniciar el worker justo cuando querés apagar las reglas es la peor combinación
posible. Un `UPDATE` de una fila toma efecto en el tick siguiente, sin reiniciar nada, y queda visible
en la pantalla en lugar de escondido en un archivo del servidor.

Corolario para T18: el worker **lee los interruptores en cada tick**, no al arrancar. Cachearlos en
memoria convertiría el "apagar todo" en un "apagar todo dentro de un rato".

**Y el corolario que faltaba, que es el que hace que el freno sea de verdad: se leen ANTES de la
primera llamada a Meta del tick, no adentro del motor.**

La versión anterior de este plan prometía en §9.7 que con `ads_rules_enabled = false` el worker no hace
"ni una llamada a Meta", pero el orden del tick de T18 era: tomar el lease → leer el backoff →
**refrescar el gasto con `syncAdSpend`** → `correrTodas()`. Y `correrTodas()` es el primero que consulta
los interruptores. O sea: con las reglas apagadas, el worker igual salía a pedirle insights a Meta cada
minuto. Un operador que apaga las reglas creyendo que aisló Meta se llevaba una sorpresa, y el criterio
de aceptación era imposible de cumplir.

El orden correcto es leer los interruptores **como paso 1 del tick**, fijar una instantánea y pasarla
hacia abajo. Si `ads_rules_enabled` está en `false`, el tick loguea y sale: sin sync, sin discovery, sin
insights y sin mutaciones.

**Los dos interruptores siguen siendo dos, y hacen cosas distintas y bien separadas:**

| Interruptor | En `false`/`true` seguro | Qué corta exactamente |
|---|---|---|
| `ads_rules_enabled = false` | **corta TODO**: ni sync, ni insights, ni escrituras. El tick no habla con Meta. |
| `ads_rules_force_dry_run = true` | **corta sólo las escrituras**: lee, evalúa y registra; ningún POST. |

Son dos semánticas distintas y por eso tienen dos nombres distintos. El primero es el freno de mano; el
segundo es el que deja mirar un día entero de decisiones simuladas. **El mismo freno de escritura lo
aplican los endpoints manuales del panel**: un freno que sólo funciona por el camino del cron no es un
freno (con la excepción documentada de las acciones manuales, D-A12c).

**D-A12c — Los interruptores globales NO frenan las acciones manuales del gestor.** Son para el motor
automático; una acción manual es una persona apretando un botón a propósito. Está dicho acá y no sólo en
T17 para que nadie lo "arregle" en un refactor. Lo que sí las frena es el techo absoluto de D-A9c, que no
tiene excepciones.

**D-A13 — El motor corre como worker de PM2, no como línea de cron.** La cadencia pedida es de 1
minuto. Con cron serían 1.440 arranques de `tsx` por día (~1-2 s de boot cada uno) y, peor, el estado
del backoff se perdería entre corridas. Un segundo proceso de PM2 (`panel-reglas`) arranca una sola vez
y se reinicia solo si se cae.

**La exclusión mutua es un lease en la base CON DUEÑO, y no `pg_try_advisory_lock`.** El lock de sesión
de PostgreSQL vive atado a la conexión y `lib/db.ts` sólo expone `getPool`, `q`, `q1` y `tx`: no hay
dónde sostenerlo sin agregar un `getClient` (y la variante transaccional obligaría a tener un `BEGIN`
abierto durante llamadas a Meta que tardan hasta 30 s, lo que bloquea el autovacuum). Una fila con un
`UPDATE` condicional es atómica igual, no retiene conexión, y encima se puede mirar desde el panel para
saber si el worker está vivo.

**Lo que sí estaba mal era el lease sin dueño, y el bug no se ve leyéndolo.** La versión anterior
guardaba el timestamp de la toma y renovaba con `WHERE value = '' OR value::timestamptz < now() -
interval '3 minutes'`. Con vencimiento de 3 minutos y cadencia de 1 minuto, **el propio worker no puede
renovar en el tick siguiente**: su lease todavía no venció, así que el `UPDATE` no matchea ninguna fila y
el tick se descarta. No hay excepción ni log raro: la cadencia real pasa de 1 a 3 minutos, en silencio y
para siempre. La prueba anterior no lo detectaba porque sólo hacía dos `UPDATE` consecutivos.

El valor de `settings.ads_worker_lease` es un objeto y `{}` significa libre:

```json
{ "owner": "<pid>-<random>", "expires_at": "2026-08-12T14:32:10.123Z" }
```

Con eso, las tres operaciones son correctas: el dueño actual **siempre** puede renovar, otro proceso sólo
entra si el lease venció, y liberar es un compare-and-set por dueño, así que un proceso no puede liberar
el lease de otro. **Se libera también al terminar un tick normal**, no sólo en `SIGTERM`. El SQL de las
tres está en T18 §3 y probado en `_verificacion-016.sql` §10, que ahora cubre renovación, liberación
ajena, liberación propia y recuperación de un lease vencido.

**El lease envuelve el tick completo, incluido el sync que alimenta las decisiones.** Si el sync quedara
afuera, dos procesos podrían escribir `ad_spend` a la vez y el motor decidiría sobre una foto a medias.

**D-A14 — Backoff adaptativo obligatorio, leyendo los headers de uso de Meta.** Un minuto es
agresivo: son ~1.440 lecturas de insights por cuenta por día. Meta informa el consumo en
`X-Business-Use-Case-Usage` y responde `17 / 2446079` ("User request limit reached") o
`613 / 1487742` ("too many calls from this ad-account") cuando se pasa. El worker afloja al 75% de
cualquiera de las métricas de uso, se detiene al 95% y respeta `estimated_time_to_regain_access`.

**Para que esa política sea implementable hacen falta dos cosas que el cliente actual no tiene.**

**1. El error de Meta se guarda entero.** Hoy `MetaAdsError` conserva `message`, `code` y `type`
(`lib/ads/meta.ts:58-67`) y descarta el resto. Con eso no se puede distinguir un throttle transitorio de
un error permanente de permisos, que es justo la decisión que el backoff necesita tomar. Se agregan
`error_subcode`, `is_transient`, `fbtrace_id` y el `status` HTTP. Son cuatro campos y son la diferencia
entre "esperar y reintentar" y "parar y avisar".

**2. El uso se guarda por cuenta, no "el de la última respuesta".** Un `ultimoUso()` global se sobrescribe
con cada llamada, así que una respuesta sana de la cuenta B tapa la saturación de la cuenta A y el worker
sigue golpeando a A. La firma correcta es `ultimoUso(accountId)`, con un `Map` por cuenta.

**Y el castigo se persiste con su estado, no sólo con su fecha de vencimiento.** La política dice "se
duplica en cada reincidencia hasta 60 minutos y se vuelve al intervalo normal después de dos ticks
limpios". Eso no cabe en un `until` y un `reason`: al reiniciar PM2 se pierde en qué escalón del castigo
estaba y cuántos ticks limpios lleva, que es exactamente el estado que el backoff necesita recordar. Son
cuatro filas de `settings`:

```
ads_backoff_until        hasta cuándo está frenado
ads_backoff_reason       el motivo, en castellano, para el panel
ads_backoff_failures     reincidencias consecutivas → duración del castigo
ads_backoff_clean_ticks  ticks seguidos por debajo del 50% de cuota
```

**El backoff es por app y frena el tick entero**, no por cuenta. Con dos cuentas alcanza. El header de
uso viene por cuenta, así que el dato para abrirlo por cuenta ya está el día que haga falta (P-A08).

**D-A15 — Telegram se configura con un script interactivo y el token va en `settings`.** El usuario
pidió poner el bot token y el chat id sin editar archivos. El script descubre el chat id solo
(le manda un mensaje al bot y lee `getUpdates`) y prueba el envío. Va en `settings` y no en el env
porque cambiar `.env.production` obliga a reiniciar PM2; el token se enmascara al leerlo por la API y
nunca se escribe en un log.

**D-A16 — Solo Meta.** La columna `platform` de `ad_spend` ya existe y queda como está. No se agrega
abstracción para otras plataformas: sería una interfaz diseñada contra una sola implementación.

**D-A16b — La versión de la Graph API es configurable y se verifica al desplegar. No se congela en el
código.** Hoy está fija en `v21.0` (`lib/ads/meta.ts:26`) y los curls de las tasks la repitieron.

El problema es de calendario: la [política de versionado de Meta](https://developers.facebook.com/docs/graph-api/guides/versioning/)
dice que cada versión funciona al menos dos años y deja de servir dos años después del release de la
siguiente. `v21.0` salió en octubre de 2024 y `v22.0` a principios de 2025, así que **el sunset de v21
cae alrededor de principios de 2027**: meses, no años, desde hoy. *(Contenido reformulado por
restricciones de licencia.)*

No pude confirmar la fecha exacta: la página oficial de changelog de versiones devuelve un error SSL al
intentar leerla, y las páginas cacheadas que sí responden siguen anunciando v21 como "la última", que es
información vieja. **Así que la fecha va a §10 como pregunta abierta (P-A10), no como dato.**

Lo que sí se decide:

- La versión sale de una env var (`META_API_VERSION`) con default, **validada contra un formato**
  (`v<número>.<número>`) para que un typo no genere una URL rarísima.
- `npm run ads:token` imprime la versión en uso y hace una llamada trivial con ella. Un deploy no puede
  quedar apuntando a una versión que ya no responde sin que nadie se entere.
- **Subir de versión no es cambiar el prefijo de la URL.** Hay que revisar `status`, presupuestos,
  insights, el sobre de error y los headers de rate limit, porque los cuatro cambiaron entre versiones
  antes. Va con su propia verificación, no de arriba.

**D-A17 — La migración es aditiva, y el lock sobre `orders` se MIDE antes de tomarlo.** Ni un `DROP`, ni
un `ALTER` que reescriba una tabla, ni un cambio de tipo. La 014 pudo hacer `DROP TABLE ad_spend` porque
estaba vacía; hoy no lo está.

La 016 crea **un solo índice** sobre `orders` (`orders_purchased_at_idx`), con `CREATE INDEX` normal y no
`CONCURRENTLY`, porque el runner envuelve cada archivo en una transacción y `CONCURRENTLY` no puede correr
adentro de una. Eso toma un lock de escritura sobre una tabla que recibe pedidos.

**"`orders` tiene miles de filas y el lock dura milisegundos" era un supuesto, no una medición**, y nadie
consultó producción. En la base local son dos filas, que no dice nada. Así que T13 §3 arranca con un
preflight: contar filas, medir tamaño, poner `lock_timeout` para que la migración **falle rápido en lugar
de colgar los pedidos**, y decidir con el número en la mano. Si la tabla resulta grande, el índice se crea
a mano con `CONCURRENTLY` antes de migrar y la migración lo encuentra hecho por el `IF NOT EXISTS`.

**Los tres índices sobre las columnas UTM se eliminaron del DDL**, y esto es una corrección, no un
recorte. Eran B-tree sobre `utm_campaign`, `utm_medium` y `utm_content` completos, y la consulta de T15 no
busca `utm_campaign = 'algo'`: matchea con `~` y extrae el id con `substring`. Un B-tree sobre el valor
completo no puede responder ninguna de las dos cosas. Eran tres índices que nunca se usaban, sobre una
tabla de escritura activa, pagando mantenimiento en cada orden nueva. Si con volumen real el
`EXPLAIN (ANALYZE, BUFFERS)` de T15 §8 muestra que el filtro por UTM es el cuello de botella, el índice
correcto es **de expresión sobre el id ya extraído, con la misma expresión que usa la query**, y va en una
017 medida. El comentario del DDL tiene el `CREATE INDEX` listo para ese caso.

**D-A18 — Cero dependencias nuevas de npm.** Todo se hace con lo que ya está: `pg`, `zod`, `recharts`,
el `fetch` nativo de Node 20 y el kit de `components/ui.tsx`. **T13 declara todos los scripts de
`package.json`** del módulo de una sola vez, igual que hizo T01, para que ningún otro task tenga que
tocar ese archivo.

**D-A19 — Nadie modifica `components/ui.tsx`.** Cuatro tasks lo importan. Los controles que faltan
(un toggle y un campo de presupuesto editable en línea) viven dentro del archivo de la vista que los
usa. Es la misma razón por la que T05 lo dejó cerrado.

---

## 2. Arquitectura

```
                      ┌───────────────────────────────────┐
   Meta Marketing API │  graph.facebook.com/v21.0          │
                      └───┬──────────────────┬─────────────┘
        lectura (ads_read)│                  │ escritura (ads_management)
    insights + jerarquía  │                  │  POST /{id} status | daily_budget
                          ▼                  ▲
        ┌─────────────────────────────────────────────────────┐
        │ lib/ads/meta.ts        cliente único, timeout,       │
        │                        paginación, MetaAdsError      │
        └──┬──────────────┬───────────────────────┬────────────┘
           │              │                       │
   ┌───────▼──────┐ ┌─────▼─────────┐   ┌─────────▼──────────┐
   │ sync.ts      │ │ jerarquia.ts  │   │ reglas/ejecutor.ts │
   │ (ya existe)  │ │ campañas,     │   │ pausar, activar,   │
   │ gasto→ad_spend│ │ conjuntos, ads│   │ presupuesto        │
   └───────┬──────┘ └─────┬─────────┘   └─────────┬──────────┘
           │              │                       │
           ▼              ▼                       │
   ┌──────────────────────────────────┐           │
   │ Postgres                          │           │
   │  ad_spend · ad_campaigns          │           │
   │  ad_sets · ads · orders           │           │
   └──────────────┬───────────────────┘           │
                  │                                │
       ┌──────────▼──────────┐                     │
       │ lib/queries/ads.ts  │  gasto ⋈ ventas     │
       │ métricas por objeto │  por id de UTM      │
       └──────────┬──────────┘                     │
                  │                                │
        ┌─────────┴──────────┐                     │
        ▼                    ▼                     │
   ┌─────────┐      ┌──────────────────┐           │
   │ UI      │      │ reglas/motor.ts  │───────────┘
   │ gestor  │      │ evaluación PURA  │
   └─────────┘      └────────┬─────────┘
                             │            ┌──────────────────┐
                             ├───────────▶│ ad_rule_runs     │
                             │            │ ad_actions       │  auditoría
                             │            └──────────────────┘
                             │            ┌──────────────────┐
                             └───────────▶│ Telegram         │
                                          └──────────────────┘

   PM2: panel-3005 (la app)  +  panel-reglas (el worker, tick de 1 min)
```

La pieza que hace testeable todo esto es que **la evaluación es pura**: `reglas/motor.ts` recibe una
regla, sus condiciones y una fila de métricas, y devuelve una decisión. No toca la red ni la base. El
efecto vive en `reglas/ejecutor.ts`. Sin esa separación, probar "qué pasa si el ROI es 1,29" requiere
una cuenta de Meta.

---

## 3. Schema — fuente de verdad

**`_schema-016.sql` de esta carpeta es el DDL canónico y se ejecutó** contra un PostgreSQL 16 con
las migraciones 001-015 aplicadas: corre limpio y es idempotente (la segunda corrida no hace nada).
T13 lo copia a `db/migrations/016_ads_gestion.sql` tal cual. Se copia, no se mejora.

**`_verificacion-016.sql` prueba las 14 afirmaciones lógicas** de las que dependen T14, T15, T16 y
T18, y corrió en verde: los CHECK que rechazan reglas peligrosas, que una regla nazca apagada y en
sombra, la extracción del id desde el UTM con y sin espacios, la diferencia de día entre las dos
zonas horarias, la aritmética del presupuesto en céntimos, que las simuladas no consuman cupo del
cooldown y las indeterminadas sí, que borrar una regla no borre su historial ni sus corridas, el lease
con dueño, la coherencia de dirección del porcentaje, techo contra piso, y el evento de configuración
global. Corrélo después de migrar.

> **Cómo leer "corrió en verde".** Sólo los bloques 1, 2, 3, 10, 12 y 13 tiran una excepción si fallan.
> Los demás **imprimen** y su `\echo` dice qué se espera: hay que leer la salida y comparar. Ese es el
> agujero por el que la versión anterior de ese archivo tuvo durante semanas un §7 que contradecía a
> D-A9 sin que nadie lo notara: corría sin error y calculaba mal.

Las tablas nuevas:

| Tabla | Para qué |
|---|---|
| `ad_campaigns` | campañas: nombre, objetivo, `status`, `effective_status`, `budget_level`, presupuesto |
| `ad_sets` | conjuntos: ídem + `optimization_goal`, `billing_event` |
| `ads` | anuncios: nombre y estado. **Sin presupuesto**, porque en Meta no existe |
| `ad_rules` | las reglas, con 18 CHECK que hacen imposible guardar una regla peligrosa |
| `ad_rule_conditions` | las condiciones, en filas, combinadas con **AND** |
| `ad_rule_runs` | una fila por corrida de una regla: cuántos objetos vio, cuántos cumplieron |
| `ad_actions` | una fila por objeto que **cumplió**, real o simulada, con `explicacion` en castellano, `estado` de la mutación y `metrics` congeladas |

Más **1** índice nuevo sobre `orders` (`purchased_at`; los tres de UTM se sacaron, D-A17) y **14** filas
en `settings`: los dos interruptores de D-A12, el TTL de insights, los dos topes monetarios de D-A9c, las
tres de Telegram, las cuatro del backoff (D-A14) y las dos del lease del worker (D-A13).

**`ad_actions` no lleva una fila por objeto evaluado, sólo por objeto que cumplió.** Los que no cumplen
se cuentan en `ad_rule_runs.objetos_evaluados` y nada más, por dos razones que van juntas: una condición
que no se dio **no es** "una acción simulada" y registrarla como tal hace que el historial afirme algo que
no pasó; y con un tick por minuto sobre unos cientos de objetos serían cientos de miles de filas por día
en la misma tabla que sostiene el cooldown. La auditoría se vuelve inútil por ruido antes de volverse
lenta por tamaño.

### Y el seed de las seis reglas del usuario

La §6 de `_schema-016.sql` carga **las seis reglas que el usuario ya tenía corriendo en Utmify**,
traducidas 1:1 de su export (`_reglas-utmify.csv`, en esta carpeta). Nacen apagadas y en modo sombra
como cualquier regla: el seed carga la configuración, no la enciende.

| Regla | Alcance | Acción | Condiciones (todas con Y) | Cadencia |
|---|---|---|---|---|
| Activar todas a las 0 horas… | campañas pausadas | activar | `roi > 1,3` | 1×día, 00:00, últimos 7d sin hoy |
| Duplicar a $25… | conjuntos activos | escalar al 250%, techo €25 | `ventas > 2` · `roi > 1,3` · `gasto < €10` · `presup < €11` | cada 15 min, hoy |
| Duplicar a $75… | conjuntos activos | escalar al 250%, techo €75 | `roi > 1,3` · `gasto > €15` · `presup €20-30` | cada 15 min, hoy |
| Duplicar a $150… | conjuntos activos | escalar al 250%, techo €150 | `roi > 1,3` · `gasto > €50` | cada 15 min, hoy |
| Apagar - Gasto +$10 ROI -1.10 | conjuntos activos | pausar | `roi < 1,1` · `gasto > €7` | cada 15 min, hoy |
| Apagar - Gasto +$4 sin ventas | conjuntos activos | pausar | `gasto > €4` · `ventas = 0` | cada 15 min, hoy |

Cuatro traducciones que hay que entender, y están comentadas en el SQL:

1. **Los montos pasan de céntimos a EUR.** Utmify guarda `spend: 1000` para €10,00. Acá las condiciones
   están en EUR, igual que `budget_max`. Copiar los céntimos convertiría "apagar si el gasto pasa de €4"
   en "si pasa de €400", y la regla no se dispararía nunca.
2. **`LastSevenDays` es `7d_excl_today`.** Una campaña pausada no gastó hoy: mirar hoy la dejaría
   pausada para siempre.
3. **`OncePerDay` a la hora 0** se expresa con tres cosas juntas: ventana `00:00-00:59`,
   `every_minutes = 1440` y `max_runs_per_day = 1`. Las tres, para que no pueda repetirse ni correr a
   otra hora aunque el worker se reinicie a las 3 de la tarde.
4. **Los nombres se conservan con sus imprecisiones.** "Duplicar" es escalar al 250%, los `$` son euros,
   y en «Apagar - Gasto +$10» la condición real es €7,00. Son los nombres con los que el usuario
   reconoce sus reglas y van a estar en el historial durante meses.

**La cadencia queda en 15 minutos, como en el export**, no en 1 minuto. El módulo soporta 1 minuto
(D-A13) pero cambiar la configuración que el usuario tenía andando es una decisión suya, no del seed: se
cambia con un click en `/anuncios/reglas`.

**Los frenos que Utmify no tenía** (`executionLimit` viene vacío en las seis) se eligieron para **no
alterar el comportamiento de la escalera**: cooldown de 15 minutos, igual que la frecuencia, y 6
acciones por objeto por día en las reglas de presupuesto. La escalera ya es auto-limitante por diseño
del usuario —cada regla tiene una condición de `budget` que deja de cumplirse en cuanto actúa, y los
rangos de las tres no se solapan— así que los frenos son una red, no un cambio de reglas.

Dos detalles del schema que hay que entender antes de escribir código contra él:

- **`status` vs `effective_status`.** `status` es lo configurado y lo único escribible
  (`ACTIVE`/`PAUSED`/`ARCHIVED`/`DELETED`). `effective_status` es lo que Meta dice que pasa de verdad
  y agrega valores que **no se pueden escribir**: `CAMPAIGN_PAUSED`, `ADSET_PAUSED`, `WITH_ISSUES`,
  `DISAPPROVED`, `PENDING_REVIEW`, `IN_PROCESS`, `PENDING_BILLING_INFO`. Activar un conjunto cuya
  campaña está pausada devuelve 200 y no entrega nada: queda `status=ACTIVE` con
  `effective_status=CAMPAIGN_PAUSED`. La UI **tiene** que mostrar esa diferencia o el usuario no
  entiende por qué su conjunto "activo" no gasta.
- **`budget_level` en `ad_campaigns`.** `'campaign'` significa CBO: el POST de presupuesto va a la
  campaña y escribir en el conjunto falla. `'adset'` significa ABO: cada conjunto tiene el suyo. Es
  el dato que decide a qué id se le pega, y adivinarlo es la primera causa de acciones fallidas.

---

## 4. Contrato de las métricas por objeto — CONGELADO

Lo declara **T13** en `lib/ads/tipos.ts`, lo implementa **T15** en `lib/queries/ads.ts`, y lo consumen
T16 (para evaluar), T17 (para la tabla) y T18 (para el mensaje de Telegram). Los cuatro se escriben
al mismo tiempo contra este contrato, así que no se cambia.

```ts
export type NivelAds = 'campaign' | 'adset' | 'ad';

/** Una fila de la tabla del gestor y la entrada de una evaluación de regla. */
export type MetricasObjeto = {
  level: NivelAds;
  objectId: string;
  objectName: string | null;
  accountId: string;
  /** Los tres ids de la jerarquía, siempre poblados: permiten subir al padre. */
  campaignId: string;
  adsetId: string;   // '' cuando level === 'campaign'
  adId: string;      // '' cuando level !== 'ad'
  funnelId: number | null;

  status: string | null;
  effectiveStatus: string | null;
  /** Dónde vive el presupuesto de ESTE objeto. null = este nivel no lo maneja. */
  budgetLevel: 'campaign' | 'adset' | null;
  /**
   * Qué TIPO de presupuesto tiene el objeto donde vive.
   * 'daily'    → lo único que este módulo sabe escribir.
   * 'lifetime' → se muestra pero NO se edita, y las reglas de presupuesto lo
   *              omiten con motivo 'presupuesto_lifetime_no_soportado' (D-A10).
   * null       → este nivel no maneja presupuesto (siempre en los anuncios).
   * Sin este campo, un CBO con presupuesto total se ve editable y cada corrida
   * falla contra la API con un error que no dice eso.
   */
  budgetMode: 'daily' | 'lifetime' | null;
  /** En EUR, ya dividido por 100. null = no tiene presupuesto propio. */
  dailyBudgetEur: number | null;

  spendEur: number;
  impressions: number;
  clicks: number;

  sales: number;          // órdenes con status 'approved'
  revenueEur: number;     // bruto aprobado
  refundedEur: number;
  commissionsEur: number;
  costsEur: number;
  netEur: number;         // revenue − refunded − commissions − costs
  profitEur: number;      // net − spend   ← la columna GANANCIA

  /** null cuando el denominador es 0. NUNCA 0 ni Infinity: null significa "no se puede calcular". */
  roas: number | null;    // revenue / spend
  roi: number | null;     // net / spend
  cpaEur: number | null;  // spend / sales
  ctr: number | null;
  cpcEur: number | null;

  /** Última acción real (no simulada) sobre este objeto. Columna ÚLT. ACTUALIZACIÓN. */
  ultimaAccionAt: string | null;
};

export type PeriodoAds = 'today' | 'yesterday' | '7d' | '7d_excl_today';

export type FiltrosAds = {
  level: NivelAds;
  period: PeriodoAds;
  accountIds?: string[];      // vacío o ausente = todas las cuentas activas
  status?: 'active' | 'paused' | 'any';
  nombre?: string;            // substring, case-insensitive
  campaignId?: string;        // para bajar un nivel desde la tabla
  adsetId?: string;
  /**
   * Tope de filas. Default 500, máximo 1000. NO es opcional en el sentido de
   * "se puede ignorar": la respuesta siempre viene acotada, y el motor y la UI
   * tienen que saber si se cortó (ver `hayMas`). Sin esto, `GET /api/data/ads`
   * devuelve el conjunto entero y crece sin techo con la cuenta del usuario.
   */
  limit?: number;
  /** Cursor estable para la página siguiente: el objectId de la última fila. */
  after?: string;
};

export async function getMetricasAds(f: FiltrosAds): Promise<{
  filas: MetricasObjeto[];
  /** true si se alcanzó el `limit` y hay más filas detrás del cursor. */
  hayMas: boolean;
  /** Ventas del período que NO matchean ningún objeto. Se muestra, no se esconde (D-A8). */
  sinAtribuir: { sales: number; revenueEur: number };
  /**
   * El día (o rango) resuelto en la zona de la cuenta, para que la UI lo muestre.
   * `timezone` es UNA zona, así que esta llamada sólo es válida cuando todas las
   * cuentas alcanzadas comparten zona. Si no la comparten, la función TIRA en vez
   * de elegir una: ver el aviso de más abajo.
   */
  rango: { from: string; to: string; timezone: string };
  generatedAt: string;
}>;
```

**Reglas de implementación que no son negociables:**

1. **`null` y no `0` cuando el denominador es cero.** Un conjunto con €0 de gasto y 1 venta no tiene
   ROI infinito ni ROI cero: no tiene ROI. Si se devuelve `0`, la condición `ROI < 1.1` se cumple y
   la regla pausa un conjunto que todavía no gastó nada. Es el falso positivo más caro del motor.
2. **El día se agrupa en la zona de la cuenta** (D-A10):
   `(o.purchased_at AT TIME ZONE cuenta.timezone)::date`. Nunca `orders.day`.

   **Y una llamada = una zona horaria. Si las cuentas alcanzadas no comparten zona, se tira.**
   `accountIds: []` significa "todas las cuentas activas", pero el resultado tiene **un solo**
   `rango.timezone`, y `debeCorrer` de §5 evalúa la ventana horaria con **una sola** hora local. Con dos
   cuentas en zonas distintas, "hoy" y el cierre del día son distintos para cada una: una regla global
   usaría el rango equivocado para parte de las cuentas, y alrededor de medianoche o de un cambio de
   horario correría dos veces o ninguna.

   **Y las dos cuentas del usuario NO comparten zona. Verificado contra la base, no supuesto:**

   | Cuenta | Zona | Moneda |
   |---|---|---|
   | `act_2501344510302910` | `Europe/Lisbon` | EUR |
   | `act_2120381458824082` | `America/Argentina/Buenos_Aires` | EUR |

   La versión anterior de este párrafo decía "hoy las dos cuentas están en Lisboa, así que la restricción
   no cuesta nada". **Era falso**, y el `refrescarMetadatosCuentas()` lo demostró en cuanto corrió. Así
   que la restricción sí cuesta: **ninguna regla con `accountIds: []` funciona**, y las seis del seed nacen
   exactamente así.

   El error es ruidoso a propósito: `getMetricasAds` tira
   (`'zonas horarias mezcladas: act_2501…=Europe/Lisbon, act_2120…=America/Argentina/Buenos_Aires'`) en
   lugar de elegir la primera, el motor lo captura y omite la regla con
   `motivo: 'zonas_horarias_mezcladas'`, y queda en el historial en castellano. **Eso es el diseño
   funcionando**: la alternativa era calcular el ROI de una cuenta contra el gasto de otro día, en silencio.

   Consecuencia operativa inmediata, antes de encender nada: hay que **asignar una cuenta a cada regla**
   en `/anuncios/reglas`. Y si querés la misma lógica sobre las dos cuentas, son **dos reglas por lógica**
   (doce en total), porque `ad_rules_name_unico` es un índice único sobre el nombre: no podés tener dos
   «Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3». Usá un sufijo (`· Lisboa` / `· BsAs`), que es
   justamente para lo que el §3 pide que la acción "duplicar" del panel agregue uno.

   Soportarlo sin duplicar reglas es expandir cada regla por cuenta, agrupar por zona y persistir unicidad
   por `(rule_id, account_id, slot_local)`. Es un cambio de schema y de contrato, y **ya hace falta**: ver
   P-A09, cuya severidad cambió con este hallazgo.

   Y un corolario del §4 punto 2 que conviene tener presente: el corrimiento de día entre `ad_spend.day` y
   `orders.day` **aplica a `act_2501…` (Lisboa) y no a `act_2120…`**, que está en la misma zona que los
   funnels. Las dos cuentas cortan el día en momentos distintos, así que compararlas lado a lado en el
   gestor no es comparar lo mismo. Por eso `rango.timezone` se muestra en pantalla y no se esconde.
3. **La extracción del id desde el UTM**, exactamente así (verificada con espacios y sin espacios,
   `_verificacion-016.sql` §5):
   ```sql
   CASE
     WHEN utm ~ '\|\s*[0-9]{6,}\s*$' THEN btrim(substring(utm from '[0-9]+\s*$'))
     WHEN utm ~ '^\s*[0-9]{9,}\s*$'  THEN btrim(utm)
     ELSE NULL
   END
   ```
   El guardia de longitud no es decorativo: sin él, una campaña llamada "2026" se toma como un id.
4. **La lista de objetos sale de la jerarquía con `LEFT JOIN` al gasto**, no al revés. Un conjunto
   pausado que no gastó hoy tiene que aparecer con ceros; si se parte de `ad_spend`, desaparece. Y a
   la inversa: un objeto que tiene gasto pero todavía no está en la jerarquía (el sync corre después)
   aparece igual, con el nombre que trae `ad_spend`.
5. **Los `numeric` de `pg` llegan como string.** Se convierten con `Number()` una sola vez, en el
   mapeo, como en el resto de `lib/queries/`.

---

## 5. Contrato del motor de reglas — CONGELADO

Lo declara **T13** en `lib/ads/tipos.ts`, lo implementa **T16**, y lo consumen T18 (el worker) y T19
(la UI, para el preview).

```ts
export type Regla = {
  id: number; name: string; enabled: boolean; dryRun: boolean;
  accountIds: string[]; level: NivelAds;
  statusFilter: 'active' | 'paused' | 'any';
  nameFilter: string | null; nameFilterMode: 'contains' | 'not_contains';
  action: 'pause' | 'activate' | 'budget_increase' | 'budget_decrease';
  actionValue: number | null; actionUnit: 'percent' | 'fixed' | null;
  budgetMax: number | null; budgetMin: number | null;
  period: PeriodoAds;
  /**
   * Sólo 'object' en esta versión, y el CHECK ad_rules_mlevel_valido de la 016 lo
   * fuerza en la base. 'parent' ("no pauses este anuncio si el conjunto entero
   * viene bien") es una buena idea con la semántica sin definir: nadie dijo cómo
   * se resuelve el id del padre, si se deduplican dos anuncios del mismo
   * conjunto, a qué objeto se le aplica la acción ni qué se congela en `metrics`.
   * Estaba declarado en el tipo y en el DDL, y T16 sólo pasaba el `level` a
   * `getMetricasAds` sin resolver nada: una regla que la UI aceptaba y el motor
   * evaluaba al nivel equivocado. Se abre en una 017 cuando esté escrito y probado.
   */
  metricsLevel: 'object';
  everyMinutes: number;
  windowStart: string | null; windowEnd: string | null;   // 'HH:MM'
  maxRunsPerDay: number | null;
  cooldownMinutes: number;
  maxActionsPerObjectPerDay: number;
};

export type Condicion = {
  metric: 'sales' | 'revenue' | 'spend' | 'net' | 'profit' | 'roi' | 'roas'
        | 'cpa' | 'budget' | 'impressions' | 'clicks' | 'ctr' | 'cpc';
  op: '>' | '>=' | '<' | '<=' | '=' | '!=';
  value: number;
};

export type MotivoOmision =
  | 'cooldown' | 'max_por_objeto' | 'techo_alcanzado' | 'piso_alcanzado'
  | 'sin_presupuesto_en_este_nivel' | 'ya_esta_en_ese_estado'
  | 'metrica_indefinida' | 'fuera_de_ventana_horaria' | 'presupuesto_bajo_el_minimo'
  // ── Los cinco que agregó la revisión técnica. Cada uno existe porque sin él
  //    el caso terminaba en un error de Meta ilegible o, peor, en un número mal
  //    calculado en silencio.
  /** El objeto tiene presupuesto TOTAL y este módulo sólo escribe diario (D-A10). */
  | 'presupuesto_lifetime_no_soportado'
  /** La cuenta no factura en EUR y el módulo no convierte monedas (D-A10). */
  | 'moneda_no_soportada'
  /** La regla alcanza cuentas en zonas distintas: "hoy" no es uno solo (§4.2). */
  | 'zonas_horarias_mezcladas'
  /** El pedido pasa `ads_max_daily_budget_eur` o el delta del tick (D-A9c). */
  | 'tope_absoluto'
  /** Quedó una mutación sin cerrar sobre este objeto: hay que reconciliar antes. */
  | 'resultado_indeterminado_previo';

export type Decision = {
  objectId: string;
  cumple: boolean;
  /** Se cumple pero no se actúa. Cuando hay motivo, `aplicar` es false. */
  motivo: MotivoOmision | null;
  aplicar: boolean;
  /** Solo para acciones de presupuesto, en unidades mínimas (D-A6). */
  presupuestoAntes: number | null;
  presupuestoDespues: number | null;
  /** El renglón en castellano que va al historial Y a Telegram. Siempre presente. */
  explicacion: string;
  /** Las métricas con las que se decidió, para congelar en ad_actions.metrics. */
  metrics: Record<string, number | null>;
};

/** PURA: no toca red ni base. Es lo que hace testeable el módulo. */
export function evaluar(
  regla: Regla,
  condiciones: Condicion[],
  fila: MetricasObjeto,
  contexto: {
    ahora: Date;
    /** En la zona de la cuenta, para la ventana horaria. */
    horaLocal: string;
    accionesRealesHoy: number;
    ultimaAccionRealAt: Date | null;
    /** Mínimo de la cuenta en unidades mínimas, si se conoce. */
    minimoPresupuesto: number | null;
  },
): Decision;
```

**Semántica que hay que respetar al implementar `evaluar`:**

- **Todas las condiciones se combinan con AND.** No hay OR: dos reglas separadas expresan lo mismo y
  se pueden prender y apagar por separado, que es lo que se quiere a las 3 de la mañana.
- **Una métrica `null` hace que la condición NO se cumpla**, y la decisión lleva
  `motivo: 'metrica_indefinida'`. Nunca se trata `null` como 0 (§4 punto 1).
- **`ya_esta_en_ese_estado`**: si la acción es `pause` y el objeto ya está `PAUSED`, no se llama a la
  API. Ahorra cuota y, sobre todo, no llena el historial de acciones que no hicieron nada.
- **Cooldown y máximo por objeto se cuentan solo sobre acciones REALES** (`NOT dry_run AND ok`). Si
  las simuladas consumieran cupo, un día en modo sombra dejaría la regla sin acciones disponibles
  justo cuando se prende. Verificado en `_verificacion-016.sql` §8.
- **Ventana horaria en la zona de la cuenta.** Si `windowStart > windowEnd`, la ventana cruza la
  medianoche (22:00→06:00) y hay que soportarlo.
- **El presupuesto se recorta contra el techo y el piso, y además contra el mínimo de la cuenta.** Si
  ya está en el techo, la decisión es `cumple: true, aplicar: false, motivo: 'techo_alcanzado'`: se
  registra que la condición se dio pero no se hizo nada, porque "no pasó nada" y "no se pudo hacer
  nada" son distintos cuando estás debuggeando a las 3 AM.
- **`explicacion` siempre se escribe**, incluso cuando se omite. Es la razón de ser del historial.

Formato de `explicacion`, en castellano, una sola línea, con los números que decidieron. En modo
real:

```
Conjunto «PXN JEAN VAQUERO 11/08 - Copia» (act_1234): gastó €4,37 hoy con 0 ventas
→ se pausó. Condición: gasto > €4,00 y ventas = 0. Estado anterior: ACTIVE.
```

En modo sombra el verbo va en condicional y el prefijo lo dice:

```
[SIMULACIÓN] Conjunto «PXN JEAN VAQUERO 11/08 - Copia» (act_1234): gastó €4,37 hoy
con 0 ventas → se habría pausado. Condición: gasto > €4,00 y ventas = 0.
```

Y cuando se omite, dice **por qué**:

```
Conjunto «PXN BIDCAP» (act_1234): ROI 1,52 con €12,40 de gasto → cumple para subir
el presupuesto, pero no se tocó: ya está en el techo de €25,00.
```

---

## 6. Contrato de la escritura a Meta — CONGELADO

Lo implementa **T13** en `lib/ads/meta.ts`. Lo usan T14 (lectura de jerarquía) y T16 (escritura).

```ts
/**
 * Campaña tal como la devuelve Meta, sin normalizar a EUR.
 * TODOS los importes están en UNIDADES MÍNIMAS de la moneda de la cuenta (D-A6).
 */
export type MetaCampaign = {
  campaignId: string;
  name: string | null;
  objective: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null;      // unidades mínimas. null = no lo maneja este nivel
  lifetimeBudget: number | null;   // unidades mínimas. Se lee, NO se escribe (D-A10)
  bidStrategy: string | null;
  createdTime: string | null;      // ISO 8601, tal como viene de Meta
};

export type MetaAdSet = {
  adsetId: string;
  campaignId: string;              // siempre presente: es la FK hacia ad_campaigns
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  dailyBudget: number | null;      // unidades mínimas
  lifetimeBudget: number | null;   // unidades mínimas
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  createdTime: string | null;
};

export type MetaAd = {
  adId: string;
  adsetId: string;                 // FK hacia ad_sets
  campaignId: string;              // desnormalizado, como en la tabla `ads`
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  createdTime: string | null;
  // NO hay presupuesto: en Meta los anuncios no tienen (D-A5).
};

export async function fetchCampaigns(accountId: string): Promise<MetaCampaign[]>;
export async function fetchAdSets(accountId: string): Promise<MetaAdSet[]>;
export async function fetchAds(accountId: string): Promise<MetaAd[]>;

/** Moneda y zona de la cuenta. Es lo que decide si la cuenta se procesa (D-A10). */
export async function fetchCuenta(accountId: string): Promise<{
  accountId: string; currency: string | null; timezoneName: string | null;
  accountStatus: number | null;
}>;

/**
 * El mínimo de presupuesto diario de la cuenta, en unidades mínimas.
 * `null` significa "NO SÉ el mínimo", nunca "el mínimo es 0" (§5).
 *
 * OJO: esta firma sigue SIN CONTRATO VERIFICADO y por eso devuelve `null`
 * fácilmente. Ver P-A11: la versión anterior de este plan pedía los campos
 * `min_daily_budget_low_freq` y `min_daily_budget_high_freq` de `AdAccount`, y
 * NO EXISTEN en la documentación ni en el SDK oficial. Lo que sí está documentado
 * es la edge `GET /act_{id}/minimum_budgets`. T13 la prueba contra una cuenta
 * real ANTES de congelar el shape; hasta entonces, `null` y el piso lo pone el
 * usuario. Lo que no se puede hacer es inventar una lógica de mínimos y después
 * usarla como protección monetaria.
 */
export async function fetchMinimoPresupuesto(accountId: string): Promise<number | null>;

/** POST /{objectId} con status. Solo ACTIVE y PAUSED: nada irreversible (§0). */
export async function setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>;

/** POST /{objectId} con daily_budget en unidades mínimas. Entero (D-A6). */
export async function setDailyBudget(objectId: string, unidadesMinimas: number): Promise<void>;

/**
 * Lee UN objeto de Meta. Es la pieza que hace posible reconciliar: cuando un POST
 * termina en timeout no se sabe si se aplicó, y la única forma de averiguarlo es
 * preguntarle a Meta, que es el source of truth (§6b).
 */
export async function fetchObjeto(objectId: string, level: NivelAds): Promise<{
  objectId: string; status: string | null; effectiveStatus: string | null;
  dailyBudget: number | null; lifetimeBudget: number | null;
} | null>;

/** Qué permisos tiene el token. Lo usa scripts/verificar-token-ads.ts. */
export async function verificarPermisos(): Promise<{
  ok: boolean; scopes: string[]; falta: string[]; detalle: string;
  /** La versión de la Graph API con la que se habló, para el log (D-A16b). */
  apiVersion: string;
}>;

/**
 * El consumo que informó Meta para ESA CUENTA. Lo lee el backoff (D-A14).
 *
 * Lleva accountId a propósito. Un `ultimoUso()` global se sobrescribe en cada
 * llamada, así que una respuesta sana de la cuenta B tapa la saturación de la
 * cuenta A y el worker sigue golpeando a A hasta que la corta.
 */
export function ultimoUso(accountId: string): {
  callCount: number; totalTime: number; totalCPUTime: number;
  regainAccessAt: Date | null;
} | null;
```

### §6b — El sobre de error, que es parte del contrato

`MetaAdsError` hoy conserva `message`, `code` y `type` y tira el resto. El motor y el backoff necesitan
más para decidir distinto en cada caso, así que la clase crece con cuatro campos:

```ts
export class MetaAdsError extends Error {
  readonly code?: number;
  readonly type?: string;
  readonly subcode?: number;      // error_subcode: distingue 17/2446079 de 17/otro
  readonly transient?: boolean;   // is_transient: reintentar o parar
  readonly traceId?: string;      // fbtrace_id: es lo que Meta pide si hay que reportar
  readonly httpStatus?: number;   // hoy se descarta y es lo primero que se mira
}
```

**Ninguno de esos campos, ni el `message`, puede contener la URL de la llamada** (D-A3): el token viaja
ahí. Es un requisito del sobre de error, no una recomendación de estilo.

Cinco reglas para la escritura:

1. **El token va en el header `Authorization: Bearer`** (D-A3), y el `daily_budget`/`status` en el
   body como `application/x-www-form-urlencoded`. Nada de secretos ni de valores en el query string.
2. **`ARCHIVED` y `DELETED` no se escriben nunca.** La firma de `setStatus` lo hace imposible.
3. **`fetchAds` y `fetchAdSets` paginan hasta el final**, con el mismo cortafuegos de 100 páginas que
   ya tiene `fetchInsights`. Una cuenta con muchos anuncios que devuelve solo la primera página deja
   la mitad de la jerarquía sin sincronizar y sin ningún error visible.
4. **Se lee `effective_status` además de `status`** en las tres lecturas (§3).
5. **Los errores siguen siendo `MetaAdsError`, ahora con `subcode`, `transient`, `traceId` y
   `httpStatus`** además de `code` y `type` (§6b). El código de Meta es lo que distingue "sin permiso"
   (`200`) de "límite de cuota" (`17`, `613`) de "presupuesto inválido" (`100`), y el subcódigo es lo que
   distingue un `17` de cuota de usuario de otro `17`. El motor decide distinto en cada caso y el backoff
   no puede hacerlo sin esos campos.

6. **Un timeout NO es un fallo: es un resultado desconocido.** Un POST que corta a los 30 s puede haberse
   aplicado en Meta igual. Tratarlo como error y reintentar en el tick siguiente es cómo una subida de
   presupuesto se aplica dos veces. `setStatus` y `setDailyBudget` tienen que dejar distinguir las tres
   cosas: aceptado, rechazado por Meta, y **no se sabe**. Cómo se registra cada una está en §6c.

### §6c — El orden de escritura, para que no se pierda ni se duplique una mutación

Una transacción de Postgres no puede hacer atómico un POST remoto. El caso concreto: Meta acepta el
cambio, el proceso muere antes del `INSERT` en `ad_actions`, y queda una campaña modificada sin ninguna
fila que lo diga. El tick siguiente no ve la acción, no la cuenta para el cooldown, y la repite.

No hace falta un outbox completo para cerrar eso. Hace falta invertir el orden y tener un estado:

```
1. INSERT en ad_actions con estado = 'pendiente'   ← ANTES de hablar con Meta
2. POST a Meta
3. UPDATE de esa fila:
     Meta respondió éxito        → estado = 'confirmado', ok = true
     Meta respondió error        → estado = 'fallido',    ok = false, error = <mensaje>
     timeout / error de red      → estado = 'indeterminado', ok = false
4. releer el objeto en Meta (`fetchObjeto`) y actualizar la fila de la jerarquía
```

Los otros dos estados no pasan por el POST y por eso se escriben de una sola vez:

```
modo sombra                    → estado = 'simulado'   (nunca se llamó a Meta)
cumplió pero un freno lo paró  → estado = 'omitido'    (con su skipped_reason)
```

Los seis valores están cerrados por el `CHECK ad_actions_estado_valido` de la 016, y **el badge del
historial sale de esta columna** (T19 §6.1), no de combinar `dry_run`, `ok` y `skipped_reason`. Con esos
tres campos el caso `'indeterminado'` era irrepresentable: se mostraba como "error", el usuario concluía
que no pasó nada, lo hacía a mano, y el cambio se aplicaba dos veces.

Y al arrancar cada tick, **antes de evaluar nada**, se buscan las filas que quedaron sin cerrar
(`ad_actions_sin_cerrar_idx` está para eso): una `pendiente` de hace más de un minuto significa que el
proceso murió a mitad de camino. Se lee el objeto en Meta, se compara con `after_value` y se cierra la
fila en `confirmado` o `fallido`. **Meta es el source of truth**, no la base.

Tres consecuencias que no son negociables:

- **Las acciones `indeterminado` consumen cupo del cooldown y del máximo por objeto**, igual que las
  confirmadas. Ante la duda, el freno se aplica: es más barato saltear una corrida que duplicar un
  aumento. Las `fallido` no consumen cupo, porque ahí no pasó nada.
- **Un objeto con una mutación sin cerrar se omite** en esa corrida, con
  `motivo: 'resultado_indeterminado_previo'`. Se decide sobre él cuando se sepa qué pasó.
- **Después de cada escritura exitosa se refresca la fila de la jerarquía.** T17 ya lo hacía para las
  acciones manuales (su §9.8) y T16 no lo pedía para las automáticas: el resultado era que el motor
  evaluaba la corrida siguiente contra un presupuesto viejo y la escalera del usuario se disparaba dos
  veces sobre el mismo escalón.

Lo que este diseño **no** da: atomicidad de un lote. Un `POST /api/ads/acciones` con 10 ids son 10
mutaciones independientes, y si 3 fallan, 7 quedaron aplicadas. La respuesta trae el resultado por objeto
y la UI lo dice (T17 §7); **nadie promete que el lote sea todo o nada**, porque no puede serlo.

---

## 7. Dependencias y olas de paralelismo

```
                       ┌────────────────────────────────┐
                       │  T13  FUNDACIÓN DE ANUNCIOS    │  ← sola, primero
                       │  016 + contratos + escritura   │
                       │  + verificar el token          │
                       └──┬──────────┬──────────┬───────┘
            ┌─────────────┘          │          └─────────────┐
            ▼                        ▼                        ▼
   ┌─────────────────┐   ┌─────────────────────┐   ┌──────────────────┐
   │ T14 SYNC        │   │ T15 MÉTRICAS        │   │ T16 MOTOR        │   OLA A
   │ JERARQUÍA       │   │ POR OBJETO          │   │ DE REGLAS        │   3 agentes
   └────────┬────────┘   └──────────┬──────────┘   └────┬────────┬────┘
            └──────────┬────────────┘                   │        │
                       ▼                                ▼        ▼
              ┌─────────────────┐        ┌──────────────────┐ ┌──────────────────┐
              │ T17 UI GESTOR   │        │ T18 WORKER +     │ │ T19 UI REGLAS    │  OLA B
              │ + acciones      │        │ TELEGRAM+DEPLOY  │ │ + HISTORIAL      │  3 agentes
              └─────────────────┘        └──────────────────┘ └──────────────────┘
```

| Task | Depende de para COMPILAR | Depende de para VERIFICAR | Se puede correr junto con |
|---|---|---|---|
| T13 | nada | nada | **nada, va sola** |
| T14 | T13 | T13 | T15, T16 |
| T15 | T13 | T13 | T14, T16 |
| T16 | T13 | T13 (+ T14 y T15 para las verificaciones 4 en adelante) | T14, T15 |
| T17 | T13 | T13, T14, T15 | T18, T19 |
| T18 | T13, T16 | T13, **T14**, **T15**, T16 | T17, T19 |
| T19 | T13, T16 | T13, T16 | T17, T18 |

**Las dos columnas de dependencias no son una formalidad.** T18 declaraba depender sólo de T13 y T16,
pero su tick llama a `correrTodas()`, que llama a `getMetricasAds` (T15) y decide sobre objetos que
tienen que existir en la jerarquía (T14). Compila sin ellos porque el stub de `lib/queries/ads.ts` está
tipado; **su verificación no corre sin ellos**, y la verificación es lo que decide si el task terminó.
Un worker "listo" cuyo tick nunca se probó de punta a punta es exactamente la pieza que no querés
descubrir en producción a la 1 de la mañana.

Lo mismo con T16: sus verificaciones 1 a 3 (pureza, freno general) corren solas; de la 4 en adelante
necesitan métricas y jerarquía de verdad. Está dicho en su §1 y ahora también acá.

**Por qué T16 no depende de T15 aunque use sus métricas:** T13 declara el tipo `MetricasObjeto` y la
firma de `getMetricasAds` en `lib/ads/tipos.ts`. T16 evalúa contra el **tipo**, no contra la
implementación, y sus tests construyen filas a mano. Es el mismo truco que usó T01 declarando
`lib/fx.ts` para que T04 lo importara mientras T03 lo implementaba.

**Por qué T17 sí depende de T15:** una pantalla que muestra métricas no se puede verificar sin las
métricas. Se podría escribir contra el tipo, pero su sección de verificación quedaría sin correr, y
un task sin verificación corrida no está terminado.

**El límite no es la cantidad de agentes, son las dependencias.** Con 5 slots disponibles y máximo 3
tareas paralelas, hay margen de sobra. No fuerces un cuarto agente en una ola: lo único que se
consigue es un task que no puede correr su verificación.

**Si preferís ir de a uno:** T13 → T15 → T16 → T14 → T17 → T19 → T18. Ese orden deja lo que escribe
en Meta para el final.

---

## 8. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee pero
no lo escribe; si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T13** | `db/migrations/016_ads_gestion.sql`, `lib/ads/tipos.ts`, `lib/ads/meta.ts`, `lib/ads/meta.test.ts`, `scripts/verificar-token-ads.ts`, `package.json`, `.env.example`, y **el stub** de `lib/queries/ads.ts` |
| **T14** | `lib/ads/jerarquia.ts`, `lib/ads/jerarquia.test.ts`, `scripts/sync-ads-jerarquia.ts` |
| **T15** | `lib/queries/ads.ts`, `lib/queries/ads.test.ts` |
| **T16** | `lib/ads/reglas/motor.ts`, `lib/ads/reglas/explicacion.ts`, `lib/ads/reglas/ejecutor.ts`, `lib/ads/reglas/repo.ts`, `lib/ads/reglas/*.test.ts` |
| **T17** | `app/(panel)/anuncios/page.tsx`, `app/(panel)/anuncios/AnunciosView.tsx`, `app/(panel)/anuncios/SubNav.tsx`, `app/api/data/ads/route.ts`, `app/api/ads/acciones/route.ts`, `components/Nav.tsx` |
| **T18** | `lib/ads/notificar.ts`, `lib/ads/notificar.test.ts`, `scripts/run-ad-rules.ts`, `scripts/telegram-setup.ts`, `deploy/ecosystem.config.js`, `deploy/deploy.sh`, `deploy/cron.panel`, `docs/runbook-anuncios.md` |
| **T19** | `app/(panel)/anuncios/reglas/**`, `app/(panel)/anuncios/historial/**`, `app/api/ads/reglas/route.ts`, `app/api/ads/interruptores/route.ts`, `app/api/data/ads/historial/route.ts` |

`app/api/ads/interruptores/route.ts` existe como ruta propia y no como un parámetro de
`/api/config/settings` porque ese archivo está en la lista de los que nadie toca. Es el endpoint que
hace realidad D-A12b: los dos interruptores globales se cambian desde la web.

**`lib/ads/tipos.ts` es el archivo más importante del módulo y lo escribe solo T13.** Contiene los
tres contratos de §4, §5 y §6. Seis tasks lo importan y **ninguna lo puede modificar**. T13 tiene que
dejarlo completo, con todas las firmas, aunque no use ninguna.

**`app/(panel)/anuncios/SubNav.tsx` lo crea T17** con los tres links (Campañas, Reglas, Historial)
desde el principio, aunque dos de esas rutas las escriba T19 después. Next resuelve `href` en runtime,
así que un link a una ruta que todavía no existe no rompe el build (es el mismo caso que `Nav.tsx` de
T05). T19 lo importa y no lo toca.

### La única excepción a la exclusividad: `lib/queries/ads.ts`

T16 y T15 corren **en paralelo**, y `lib/ads/reglas/ejecutor.ts` (de T16) importa `getMetricasAds` de
`lib/queries/ads.ts` (de T15). Un import a un archivo que todavía no existe **no compila**: `tsc` falla y
T16 no puede correr su verificación.

Se resuelve igual que lo resolvió el plan original con `app/layout.tsx` entre T01 y T05:

- **T13 crea `lib/queries/ads.ts` como stub**: la firma completa del §4, con el cuerpo tirando
  `new Error('lib/queries/ads.ts: lo implementa T15')`. Compila, se puede importar, y falla ruidosamente
  si alguien la llama antes de tiempo.
- **T13 le deja en la primera línea el comentario `// T15 reemplaza este archivo completo.`**
- **T15 lo reemplaza entero.** No lo edita: lo reescribe.
- **T16 lo importa y nunca lo toca.**

Un stub que devuelve un array vacío en lugar de tirar sería peor: T16 pasaría sus tests contra datos
inexistentes y nadie se enteraría hasta que el motor no encuentre nada en producción.

**Ningún otro archivo se comparte entre tasks.** Y ojo con un caso que parece colisión y no lo es:
`app/api/data/ads/route.ts` es de T17 y `app/api/data/ads/historial/route.ts` es de T19. Están en el
mismo árbol de directorios pero son **dos archivos distintos**: T17 no crea el subdirectorio `historial/`
y T19 no toca el `route.ts` del padre.

**Archivos que NADIE de este módulo modifica**, y romper esto rompe producción:

```
components/ui.tsx          lib/ads/sync.ts       lib/ads/live.ts
lib/queries/sales.ts       lib/queries/overview.ts
lib/db.ts  lib/day.ts  lib/fx.ts  lib/funnels.ts  lib/types.ts
middleware.ts              app/api/config/**     app/(panel)/layout.tsx
db/migrations/001..015     scripts/rollup.ts     scripts/sync-ads.ts
```

Dos aclaraciones sobre esa lista:

- **`middleware.ts` no se toca y no hace falta tocarlo.** Su matcher ya cubre todo lo que no sea
  `/api/ingest` ni `/api/webhooks/*`, así que las rutas nuevas quedan protegidas solas. Pero eso
  **no exime** a cada route handler de llamar a su guard: es la convención del proyecto y la única
  defensa si alguien cambia el matcher.
- **`scripts/sync-ads.ts` sigue existiendo tal cual.** Sincroniza gasto y lo llama el cron. El worker
  nuevo importa `syncAdSpend` de `lib/ads/sync.ts` directamente, sin modificarla.

**`README.md` no es de nadie de este módulo, y por eso ninguna task lo edita.** La versión anterior de
T13 pedía anotar en el README qué cuenta y qué campaña se usaron para probar el token, con el README
fuera de su fila de ownership. Ese tipo de dato va a `docs/runbook-anuncios.md`, que es de T18, o a la
salida del propio `npm run ads:token`, que es de T13. Una edición fuera de scope no puede ser un criterio
de aceptación: es exactamente el conflicto que §8 existe para evitar.

**Los archivos compartidos tienen un solo dueño y está en la tabla.** `package.json` y `.env.example` son
de T13; `deploy/**` es de T18; `components/Nav.tsx` es de T17; `db/migrations/016_ads_gestion.sql` es de
T13. Si una task cree que necesita escribir uno ajeno, va a §10.

**Todos los scripts de `package.json` los declara T13**, apuntando a archivos que T14, T16 y T18
crean después. Que un script apunte a un archivo que no existe todavía no rompe el build:

```json
"ads:jerarquia": "tsx scripts/sync-ads-jerarquia.ts",
"ads:reglas":    "tsx scripts/run-ad-rules.ts",
"ads:token":     "tsx scripts/verificar-token-ads.ts",
"ads:telegram":  "tsx scripts/telegram-setup.ts"
```

---

## 9. Criterios de aceptación globales

1. `npx tsc --noEmit` y `npm run build` en cero. `npm test` pasa.
2. `npm run db:migrate` es idempotente: dos corridas seguidas, la segunda no aplica nada y sale 0.
3. **`npm run ads:token` confirma que el token puede escribir.** Sin esto, nada de lo demás sirve.
4. `_verificacion-016.sql` corre en verde contra la base migrada.
5. Sin la cookie `panel_token`, `GET /api/data/ads`, `POST /api/ads/acciones` y
   `POST /api/ads/reglas` devuelven **401** y no escriben ni una fila. Si un `curl` sin cookie
   devuelve datos, es un bug, no una comodidad.
6. **Una regla en modo sombra escribe en `ad_actions` con `dry_run = true` y el objeto en Meta no
   cambia.** Se verifica leyendo el `status` en Meta antes y después: tiene que ser idéntico. Este es
   el criterio que decide si el módulo se puede prender o no.
7. **Con `ads_rules_enabled = false`, el worker levanta, loguea que está apagado y no hace ni una
   llamada a Meta.** Y esto se verifica de verdad, no leyendo el código: se cuenta el tráfico de salida
   del tick. La forma barata es un contador de llamadas en `lib/ads/meta.ts` que el worker imprime al
   final del tick; tiene que dar **0**. El criterio es implementable sólo si el interruptor se lee como
   paso 1 del tick, antes del sync (D-A12).

7b. **El techo absoluto de D-A9c corta también los caminos manuales.** Un `curl` autenticado a
   `POST /api/ads/acciones` con `budgetEur` por encima de `ads_max_daily_budget_eur` devuelve 400 y **no
   llama a Meta**. Si pasa, el techo no existe: la confirmación de la UI no es un control de seguridad
   porque el route handler se puede invocar directo.

7c. **Ninguna URL que sale del módulo contiene `access_token`** (D-A3), incluidas las de paginación. Se
   verifica con un test sobre el cliente, no leyendo el código: la trampa está en `paging.next`, que Meta
   devuelve con el token adentro.
8. El ROI y el ROAS de un objeto coinciden con el cálculo hecho a mano en `psql` sobre `orders` y
   `ad_spend` para el mismo día y la misma zona horaria. Si no coinciden, no ajustes la query hasta
   que dé: encontrá la causa (casi siempre es la zona horaria de D-A10).
9. **Nada de lo que ya funcionaba cambió.** El gasto de Resumen y de Ventas para un rango cerrado
   devuelve exactamente los mismos números que antes de la migración. Anotá los valores antes de
   empezar.
10. Las acciones manuales del gestor quedan en `ad_actions` con `source = 'manual'` y con `actor_hint`
    lleno (IP, request id, lo que haya).

    **Y hay que ser honesto con lo que eso responde y lo que no.** El panel se autentica con una
    contraseña compartida y una cookie HMAC: no hay usuarios, ni roles, ni sesiones revocables una por
    una. `source = 'manual'` dice **por qué canal** entró la acción, no quién la hizo. Cualquier persona
    con la contraseña puede cambiar un presupuesto o apagar el modo simulación, y después no se puede
    atribuir ni revocar individualmente.

    La versión anterior de este criterio decía "una persona también es un quién". No: una persona es un
    quién, pero una contraseña compartida no identifica a una persona. `actor_hint` es lo máximo que el
    modelo de autenticación actual permite guardar, y agregar identidad individual (roles
    operador/aprobador, doble aprobación para habilitar escrituras, revocación) es un cambio en la
    autenticación de **todo el panel**, no de este módulo. Queda en P-A12 con esa magnitud declarada, no
    escondido detrás de una frase ingeniosa.

**Nota práctica para verificar con `curl`.** Igual que en el plan original, varias tasks usan
`-b "panel_token=$(cat /tmp/panel_token)"`. Ese archivo se crea a mano: te logueás en el browser,
copiás el valor de la cookie desde las devtools y lo guardás con
`printf '%s' '<valor>' > /tmp/panel_token`.

**Nota sobre `META_ADS_TOKEN` en local, que arruina cuatro tasks si no se lee ahora.** Varias
verificaciones usaban este idiom:

```bash
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)     # ← NO HAGAS ESTO
```

**Verificado: el `.env` local NO tiene `META_ADS_TOKEN`.** Sus claves son `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `DB_PORT`, `DATABASE_URL`, `DASHBOARD_TZ` y
`SHOPIFY_WEBHOOK_SECRETS`. Ese `grep` devuelve **string vacío**, `$T` queda vacío, y el `curl` sale con
`access_token=` y una respuesta de Meta que habla de credenciales inválidas. Se pierde media hora
buscando un problema de permisos que no existe.

El token hay que agregarlo al `.env` local a mano (T13 lo documenta en `.env.example`), y la lectura
tiene que **fallar fuerte** si no está:

```bash
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)
[ -n "$T" ] || { echo "FALTA META_ADS_TOKEN en .env — agregalo antes de seguir"; exit 1; }
```

**`git diff` NO sirve como criterio de aceptación en este proyecto, y hay que decirlo porque parece que sí.**

Existe un repo git en la carpeta padre (`~/Desktop/funnel`), así que los comandos de git **corren sin
error**. Pero ese repo sólo trackea `.kiro` y `funnel-mate`: **`dashboard-admin` nunca se agregó**. O sea
que todos los archivos de este proyecto son untracked, `git diff --stat` sale vacío, y un criterio de
aceptación que diga "el diff tiene que mostrar sólo los archivos de mi fila" **se cumple siempre, incluso
si pisaste `components/ui.tsx`**. Un chequeo que nunca falla no es un chequeo.

Verificado con `git ls-files dashboard-admin` (vacío) y `git ls-files | awk -F/ '{print $1}' | sort -u`
(devuelve `.kiro` y `funnel-mate`).

El chequeo que sí funciona es por fecha de modificación, y hay que **leer la lista** contra la fila de §8:

```bash
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

**Nota sobre probar contra producción.** El panel corre en la VPS con datos vivos. Para desarrollar,
levantá la base local (`docker compose up -d`) y **corré las migraciones: la base local está en la
010 y le faltan la 011 a la 015.** Verificado. Cualquier prueba que escriba en Meta usa una campaña
**pausada** elegida a propósito, nunca una que esté gastando.

---

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene.

> **Revisión técnica del 2026-08-12.** Este plan pasó por una revisión que lo rechazó y pidió rediseñarlo.
> Se verificó cada hallazgo contra el código real, el export de Utmify y la base, y el resultado fue mixto:
> varios eran defectos ciertos y están corregidos arriba (el token en la URL de todas las llamadas, el
> orden del kill switch, el lease sin dueño, la falta de techo absoluto, la ausencia de estado en las
> mutaciones, `metricsLevel = 'parent'` declarado sin implementar, los campos de mínimo de presupuesto que
> no existen, los contratos con `{ /* ... */ }` en lugar de tipos, los índices UTM que no servían para la
> consulta, y las contradicciones sobre la aritmética del porcentaje).
>
> Dos correcciones a la revisión, porque importan para no deshacer lo que estaba bien:
>
> - **La semántica del porcentaje NO había que rediseñarla.** La revisión propuso reemplazar el porcentaje
>   por `multiplier` / `percent_delta` / `fixed_minor_units`. El export real del usuario resuelve la
>   ambigüedad sin inventar nada: Utmify guarda `actionPercentInfo: 2.5` y muestra "250%", y el techo de
>   €75,00 es exactamente €30,00 × 2,5 al céntimo. **D-A9 era correcto**; lo que estaba mal eran los cuatro
>   lugares que lo contradecían (el §7 de la verificación, un comentario del DDL, dos criterios de T19 y la
>   fórmula de `fixed` de T16). Se alinearon a D-A9 en lugar de rehacer el modelo.
> - **El veredicto global era desproporcionado.** Los defectos eran localizados y se cerraron con cambios
>   acotados, no con una replanificación. Lo que sí era correcto es que **no se puede elevar el token a
>   `ads_management` ni prender escrituras** hasta que estén aplicados los cambios de D-A3, D-A9c, D-A12 y
>   §6c.
>
> Y un defecto que la revisión no vio: **el `.env` local no tiene `META_ADS_TOKEN`**, así que el
> `grep` que usaban cuatro tasks para leerlo devolvía vacío. Está corregido en §9.

```
### P-AXX — <título corto>
- **Task:** T1X
- **Sección del plan:** §4
- **Archivo:** lib/queries/ads.ts
- **Qué falta:** <la pregunta concreta>
- **Bloquea:** sí / no
- **Resolución:** <la completa el usuario>
```

### P-A01 — ¿El token tiene realmente `ads_management`?
- **Task:** T13
- **Sección:** D-A2
- **Qué falta:** El usuario dice que le dio el permiso al `META_ADS_TOKEN` pero no está verificado.
  Leer gasto (`ads_read`) y escribir (`ads_management`) son permisos distintos, y además el usuario
  del sistema tiene que tener la cuenta **asignada** con rol de administrador, no solo de analista.
  Se resuelve corriendo `npm run ads:token`, que hace una escritura no-op (poner una campaña ya
  pausada en `PAUSED`) y no cambia nada.
- **Bloquea:** **SÍ.** Es lo primero que hace T13 y si falla, ninguna otra task arranca.
- **Resolución:** **El token SÍ escribe.** `debug_token` devuelve `ads_management` y `ads_read`, y la
  escritura no-op dio `{"success":true}` sobre `120248641680500617` («anuncio bidcap 1», PAUSED,
  act_2501344510302910). El objeto quedó igual que estaba (no-op verificado antes y después).

### P-A02 — Un minuto de cadencia puede chocar con los límites de la API
- **Task:** T18
- **Sección:** D-A13, D-A14
- **Qué falta:** El usuario pidió evaluar cada minuto. Son ~1.440 lecturas de insights por cuenta por
  día. Los límites de Meta son por cuenta publicitaria y por hora, y dependen del tier de la app
  (Development es mucho más chico que Standard). No se puede saber de antemano si aguanta: se mide.
  El diseño lo absorbe con el backoff adaptativo y con `ads_insights_ttl_seconds`, que se puede subir
  desde el panel sin desplegar.
- **Bloquea:** no. Se implementa a 1 minuto con backoff. Si Meta aprieta, el worker afloja solo y lo
  anota en el log; ahí se sube el TTL.
- **Resolución:** Medido en T18 con un tick real: **2 llamadas a Meta por tick** (1 `fetchInsights` por
  cuenta), ~1,4 s/tick, y el header `x-business-use-case-usage` reporta **`ads_api_access_tier:
  development_access`** (≈1% de la cuota por cuenta por llamada). Con el tier de desarrollo, 1 minuto es
  agresivo: son ~60 ticks/hora y el backoff va a aflojar solo. Recomendado antes de encender: pedir
  `standard_access` a Meta y/o subir `ads_insights_ttl_seconds` (hoy 55 s) desde el panel sin desplegar.

### P-A03 — Confirmar la zona horaria de las cuentas
- **Task:** T15
- **Sección:** D-A10
- **Qué falta:** El usuario dice que las cuentas están en Lisboa y que debería coincidir con el
  funnel. **No coincide:** los funnels están en `America/Argentina/Buenos_Aires` (verificado en el
  default de `funnels.timezone`). Son 4 o 5 horas de diferencia según la época del año, así que el
  corte del día es distinto y por eso §4 obliga a agrupar por la zona de la cuenta.
  `ad_accounts.timezone` se llena sola con `refrescarMetadatosCuentas()`; hay que **verificar que
  tenga valor** antes de confiar en las métricas: si está en `NULL`, las queries tienen que caer a un
  default explícito y la UI avisarlo, no asumir UTC en silencio.
- **Bloquea:** no, pero si `ad_accounts.timezone` está vacío hay que correr el sync de metadatos
  antes de dar por buenos los números.
- **Resolución:** Verificado en T13 contra Meta: `act_2501344510302910` (HIlvanapp) =
  `Europe/Lisbon`, pero `act_2120381458824082` (Protocolo reset) = `America/Argentina/Buenos_Aires`,
  **no Lisboa**. El supuesto de §4 punto 2 y de P-A09 («las dos cuentas en Lisboa») es falso: las dos
  cuentas están en zonas distintas, así que `getMetricasAds` con `accountIds: []` va a tirar
  `zonas_horarias_mezcladas` y las reglas globales seedeadas (que nacen con `account_ids = '{}'`)
  quedarán omitidas hasta que se les asigne una cuenta. T15/T16/T18 tienen que leer esto.

### P-A04 — Qué hacer con una regla cuyo objeto ya no existe en Meta
- **Task:** T14, T16
- **Qué falta:** Si una campaña se borra en Meta, el sync de jerarquía la saca (o no la trae) y sus
  conjuntos y anuncios caen por `ON DELETE CASCADE`. El gasto histórico queda en `ad_spend`, que no
  tiene FK hacia la jerarquía, así que no se pierde. Lo que no está decidido es si el sync debe
  **borrar** los objetos que Meta ya no devuelve o marcarlos como desaparecidos: borrar pierde el
  nombre para el historial, marcar acumula filas para siempre.
- **Bloquea:** no. T14 implementa lo conservador: **no borra nada**, y marca con `synced_at` viejo.
  Un objeto cuyo `synced_at` quedó atrás no se lista en el gestor y las reglas lo ignoran. La limpieza
  se decide después de 30 días de operación.
- **Resolución:**

### P-A05 — La regla «Apagar - Gasto +$4 sin ventas» exporta una condición imposible
- **Task:** T13 (el seed de `_schema-016.sql` §6)
- **Sección:** §3, D-A9
- **Qué falta:** El export de Utmify trae `approvedSales LessThan 0`. Con ventas enteras y no negativas,
  **"menos que cero" no se puede cumplir nunca**: la regla, traducida literal, jamás se dispararía.
  Hay dos explicaciones posibles y no se puede saber cuál desde el CSV: que el `LessThan` de Utmify sea
  en realidad un `<=` (y entonces `< 0` significa "0 o menos", o sea 0), o que el formulario haya
  guardado un 0 donde correspondía un 1. **El seed la carga como `sales = 0`**, que es lo que dice el
  nombre de la regla y es la única lectura con sentido.
- **Bloquea:** no. Pero es el único lugar donde el seed cambia la semántica del export, así que hay que
  confirmarlo: si en Utmify esa regla efectivamente venía pausando conjuntos sin ventas, la traducción
  es correcta. Si nunca se disparó, el usuario acaba de descubrir por qué.
- **Resolución:**

### P-A06 — El nombre y la condición de «Apagar - Gasto +$10» no coinciden
- **Task:** T13 (el seed)
- **Qué falta:** El nombre dice "+$10" y el export dice `spend > 700` céntimos, o sea **€7,00**. El seed
  respeta el export, que es la regla que estuvo corriendo de verdad, y conserva el nombre tal cual.
- **Bloquea:** no. Si el usuario quería €10,00, es cambiar un campo en `/anuncios/reglas`.
- **Resolución:**

---

Las seis que siguen salieron de la revisión técnica del 2026-08-12. Ninguna bloquea el arranque, pero
**todas cambian qué se puede prometer del módulo**, así que están acá y no adentro del código.

### P-A07 — `lib/ads/sync.ts` no reconcilia el gasto que Meta corrige a la baja
- **Task:** ninguna. Es una limitación del camino que ya existe.
- **Sección:** D-A1, y §0 ("no se toca `lib/ads/sync.ts`")
- **Qué falta:** `syncAdSpend` filtra `filas.filter((f) => f.spend > 0)` (`lib/ads/sync.ts:105`) y hace
  `continue` cuando no hay filas con gasto (`:119`). El upsert es idempotente **para las filas que Meta
  devuelve**, pero no borra ni pone en cero las que dejaron de venir. Consecuencia: si Meta corrige el
  gasto de un anuncio-día a cero (crédito por tráfico inválido, ajuste de facturación), el valor viejo
  **queda persistido para siempre**, y una regla de pausar por gasto puede actuar sobre plata que ya no
  se gastó. Lo mismo con una fila que desaparece de un rango ya sincronizado.

  Es real, y a la vez su ventana de impacto es acotada: intradía el gasto de Meta sólo sube, así que el
  caso golpea sobre todo a los períodos `7d` y `7d_excl_today`, donde entran los ajustes posteriores al
  cierre. De las seis reglas del usuario, la única que mira 7 días es la de activar a las 0 horas, que
  **activa** en lugar de pausar: el peor caso es reactivar algo que no correspondía, no apagar algo que
  rendía.

  **No se reescribe el sincronizador ahora**, y esa es una decisión deliberada: es el camino por el que
  hoy entra el gasto de Resumen y de Ventas, funciona con plata real, y cambiarlo a la vez que se
  construyen siete tasks encima es cómo se rompen dos pantallas que andan. La reconciliación correcta
  (staging del slice cubierto, persistir ceros, reemplazo transaccional sólo después de terminar toda la
  paginación) es su propio task, con sus propias pruebas de corrección a cero, fila borrada, página
  parcial y fallo a mitad de sync.
- **Bloquea:** no. **Pero se mide antes de confiar en los períodos de 7 días.** T15 §8 tiene la consulta
  que cuenta cuántas filas de `ad_spend` cambiaron de valor entre sincronizaciones. Si ese número es alto,
  la reconciliación sube de prioridad y las reglas de 7 días esperan.
- **Resolución:**

### P-A08 — ¿El backoff tiene que ser por cuenta y no por app?
- **Task:** T18
- **Sección:** D-A14
- **Qué falta:** Hoy `ads_backoff_until` frena el tick entero. Si una cuenta se satura y la otra está
  sana, las dos quedan frenadas. Con dos cuentas es aceptable; con más, el módulo se autolimita de más.
  El header `x-business-use-case-usage` **ya viene por cuenta**, así que el dato para abrirlo existe: es
  cambiar dos filas de `settings` por una tabla o un jsonb con una entrada por cuenta.
- **Bloquea:** no. Se implementa por app y se anota cuántas veces frenó por culpa de una sola cuenta.
- **Resolución:**

### P-A09 — Una regla global no puede operar sobre cuentas en zonas distintas
- **Task:** T15, T16
- **Sección:** §4 punto 2, §5
- **Qué falta:** `accountIds: []` significa "todas las cuentas", pero `rango` tiene una sola `timezone` y
  `debeCorrer` una sola hora local. Con cuentas en zonas distintas, "hoy", la ventana horaria y el cierre
  del día son distintos para cada una, y alrededor de medianoche o de un cambio de horario la regla corre
  dos veces o ninguna. Soportarlo bien es expandir la regla por cuenta, agrupar por zona y persistir
  unicidad por `(rule_id, account_id, slot_local)`: cambio de schema y de contrato.
- **Bloquea:** **ya no es hipotético.** La versión anterior de esta pregunta decía "no bloquea, porque las
  dos cuentas del usuario están en Lisboa", y esa premisa resultó falsa en cuanto corrió
  `refrescarMetadatosCuentas()`:

  | Cuenta | Zona |
  |---|---|
  | `act_2501344510302910` | `Europe/Lisbon` |
  | `act_2120381458824082` | `America/Argentina/Buenos_Aires` |

  Así que **ninguna regla con `accountIds: []` funciona**, y las seis del seed nacen exactamente así. El
  día que "entrara una cuenta fuera de Lisboa" ya había pasado antes de que el módulo se escribiera.

  Lo que la restricción sí hizo bien: **falló ruidosamente en lugar de calcular mal**. El motor omite cada
  regla global con `motivo: 'zonas_horarias_mezcladas'` y lo escribe en el historial, en vez de resolver
  "hoy" en la zona de la primera cuenta y decidir el ROI de la otra contra el gasto de otro día. Ese es
  exactamente el modo de falla que la revisión técnica señaló (B8) y por el que se eligió prohibir en lugar
  de soportar a medias.
- **Resolución:** parcial, y hay dos caminos.

  **Ahora (sin código):** asignar **una cuenta a cada regla** en `/anuncios/reglas`. Si querés la misma
  lógica sobre las dos cuentas son doce reglas, con nombres distintos porque `ad_rules_name_unico` es un
  índice único sobre el nombre: usá un sufijo (`· Lisboa` / `· BsAs`). Funciona hoy, sin tocar nada, y el
  costo es mantener la escalera duplicada.

  **Después (con código):** la expansión por cuenta. `correrRegla` itera las cuentas alcanzadas, llama a
  `getMetricasAds` una vez por cuenta, y `debeCorrer` evalúa la ventana y la cadencia con la hora local de
  esa cuenta. Necesita `last_run_at` y el conteo de corridas **por (regla, cuenta)**, así que es una 017 con
  una tabla o columnas nuevas. Con dos cuentas es la diferencia entre 6 reglas y 12; con más, es la
  diferencia entre usable e inmanejable.

  **Recomendación:** arrancá con el camino manual —seis reglas sobre `act_2501…`, que es la que el usuario
  venía mirando en Utmify— y dejá la segunda cuenta afuera hasta ver un día de sombra. Encender doce reglas
  a la vez sobre dos cuentas con cortes de día distintos es mucho a la vez para el primer día.

### P-A10 — ¿Qué versión de la Marketing API y hasta cuándo vive la v21?
- **Task:** T13
- **Sección:** D-A16b
- **Qué falta:** El código está fijo en `v21.0`. La política oficial de Meta es que cada versión vive al
  menos dos años y muere dos años después del release de la siguiente, así que con `v22.0` publicada a
  principios de 2025, **el sunset de v21 cae alrededor de principios de 2027**. No pude confirmar la fecha
  exacta: la página oficial de changelog de versiones devuelve un error SSL y las páginas cacheadas que sí
  responden siguen anunciando v21 como la última, que es información vieja. *(Contenido reformulado por
  restricciones de licencia.)*
- **Bloquea:** no, pero es lo primero que hay que confirmar con el navegador abierto. Mientras tanto la
  versión sale de `META_API_VERSION` y `npm run ads:token` la imprime. Subir de versión **no es cambiar el
  prefijo**: hay que revisar `status`, presupuestos, insights, el sobre de error y los headers de cuota.
- **Resolución:**

### P-A11 — El mínimo de presupuesto de la cuenta no tiene contrato verificado
- **Task:** T13
- **Sección:** §6, `fetchMinimoPresupuesto`
- **Qué falta:** La versión anterior de este plan pedía los campos `min_daily_budget_low_freq` y
  `min_daily_budget_high_freq` de `AdAccount`. **No existen** en la documentación de Meta ni en el objeto
  `AdAccount` del SDK oficial, y el plan no aportaba ningún endpoint ni respuesta real que los
  respaldara: la fundación habría fallado en la primera consulta o, peor, alguien habría inventado una
  lógica de mínimos y después la habría usado como protección monetaria.

  Lo que sí está documentado es la edge [`GET /act_{id}/minimum_budgets`](https://developers.secure.facebook.com/docs/marketing-api/reference/ad-account/minimum_budgets/).
  T13 la prueba contra una cuenta real y **recién ahí** se congela el shape (qué campos trae, en qué
  unidad, si varía por objetivo o por billing event).
- **Bloquea:** no. Hasta que se verifique, `fetchMinimoPresupuesto` devuelve `null` y el piso lo pone el
  usuario. `null` es "no sé el mínimo", **nunca** "el mínimo es 0".
- **Resolución:** Verificado en T13. `GET /act_{id}/minimum_budgets` devuelve `data[]` con **un renglón
  por moneda** (la misma lista para cualquier cuenta), cada uno con
  `{currency, min_daily_budget_imp, min_daily_budget_video_views, min_daily_budget_high_freq,
  min_daily_budget_low_freq}`. Para EUR: `imp=87`, `video_views=87`, `high_freq=435`, `low_freq=3473`
  (unidades mínimas = céntimos). `fetchMinimoPresupuesto` congela el piso en `min_daily_budget_imp`
  (€0,87): es el mínimo absoluto que Meta acepta y se usa solo como piso para no pedir presupuestos
  que Meta rechaza. Los campos high/low_freq (€4,35 / €34,73) dependen de objetivo y billing event y
  quedan sin usar por ahora.

### P-A12 — El panel no sabe quién hizo cada cosa, y este módulo mueve plata
- **Task:** ninguna. Es de la autenticación del panel entero.
- **Sección:** §9 criterio 10
- **Qué falta:** Autenticación por contraseña compartida y cookie HMAC, sin usuarios, sin roles y sin
  sesiones revocables una por una. Cualquiera con la contraseña puede cambiar un presupuesto, apagar el
  modo simulación global o subir el techo absoluto, y después no hay forma de atribuirlo ni de revocarle
  el acceso a una sola persona. `actor_hint` guarda el rastro técnico de la petición y es lo máximo que
  este modelo permite.

  Lo correcto es identidad individual, roles operador/aprobador, doble aprobación para habilitar
  escrituras y cambiar topes, y revocación. Es un cambio en la autenticación de **todo el panel**, no de
  esta sección, y ninguna task de este módulo lo puede hacer sin salirse de su ownership.
- **Bloquea:** no para construir. **Sí es un factor a considerar antes de apagar
  `ads_rules_force_dry_run`**: a partir de ese momento una contraseña compartida es lo único que separa a
  cualquiera del presupuesto de la cuenta.
- **Resolución:**

---

## 11. Lo que este módulo NO resuelve, dicho de frente

Para que nadie construya encima creyendo que están cubiertas.

1. **Atomicidad de un lote.** Un POST con 10 ids son 10 mutaciones independientes. Si 3 fallan, 7 quedaron
   aplicadas. La respuesta lo dice por objeto (§6c); nadie promete todo-o-nada, porque no se puede.
2. **Reconciliación del gasto corregido a la baja** (P-A07). Se documenta y se mide; no se arregla acá.
3. **Identidad individual y autorización** (P-A12). Se guarda el rastro de la petición, no la persona.
4. **Otras monedas y presupuestos totales** (D-A10). Se rechazan explícitamente en lugar de fallar raro.
5. **`metricsLevel = 'parent'`** (§5). La base lo rechaza hasta que la semántica esté escrita.
6. **Backoff por cuenta** (P-A08). Es por app: una cuenta saturada frena el tick entero.
7. **Métricas y alertas del worker** más allá de `ads_worker_last_tick` y el aviso de Telegram. No hay
   dashboards de lag, ni de cuota consumida, ni de tasa de error por cuenta.
8. **Rollout gradual por cuenta o por acción.** El módulo se prende entero (con sombra global primero).
   Habilitar una sola cuenta o una sola acción de bajo riesgo hay que hacerlo a mano, apagando reglas.
9. **Retención y particionado de la auditoría.** `ad_actions` y `ad_rule_runs` crecen sin purga. Con el
   diseño de §3 (una fila por objeto que **cumple**, no por objeto evaluado) el crecimiento es manejable
   por bastante tiempo, pero el plan de purga hay que escribirlo antes de que la tabla lo pida.
