# Requisitos del arreglo: parseo de montos en Anuncios

## Introduction

Un campo de plata del panel de Anuncios lee `1.000` como **1**. No falla, no
avisa: dice OK y escribe el importe en la campaña real de Meta. El mismo agujero
está en tres lugares distintos, porque el parseo de números tipeados a mano está
escrito tres veces y ninguna de las tres copia usa el criterio de Finanzas, que
es la única implementación correcta que hay en el repo.

Los tres sitios son un solo bug:

| Sitio | Función | Archivo |
|---|---|---|
| Diálogo de presupuesto de Anuncios | `parsearPresupuesto` | `lib/ads/presupuesto.ts:86` |
| Valores y condiciones de Reglas | `numeroDeTexto` | `app/(panel)/anuncios/reglas/ReglasView.tsx:574` |
| Límite de ejecuciones diarias de Reglas | `Number()` crudo | `app/(panel)/anuncios/reglas/ReglasView.tsx:674` y `:719` |

Se tratan juntos porque el arreglo razonable es **compartir un parseo**, no
escribir una cuarta copia. `app/(panel)/finanzas/monto.ts` (`parsearMonto`, 12
tests) ya resuelve exactamente este problema con la regla correcta: un campo de
plata no adivina, y cuando la entrada es ambigua devuelve un error que se le
muestra a la persona en lugar de elegir una lectura y escribirla.

Se suma un cuarto defecto, independiente y trivial, del mismo modo de falla
silenciosa: `hover:text-good-100` en `app/(panel)/anuncios/ChipCascada.tsx:53`
es un token que no existe en `tailwind.config.ts`, así que no emite CSS y el
hover del botón «Limpiar el filtro de cascada» no cambia de color.

### Por qué llega hasta Meta

El importe corrompido no lo detiene ninguna capa posterior:

- El input es `type="number"` con `min`/`max`/`step` (`FormularioPresupuesto.tsx:48`).
  `1.000` es un float válido para el browser y 1 está dentro del rango, así que
  el browser tampoco protesta.
- El backend no es una segunda línea de defensa: el schema `presupuestoEur`
  (`app/api/ads/acciones/route.ts:110`, usado en `:190`) recibe un `number` ya
  parseado por el cliente. Recibe 1 y lo acepta como importe legítimo.
- `aplicarPresupuesto` (`app/api/ads/acciones/route.ts:889`) hace
  `Math.round(budgetEur * 100)` y manda `campos: { daily_budget: '100' }`. Se
  escribe en un sistema externo, en vivo, y con plata.

### Estado del repo cuando se detectó

`npx tsc --noEmit` limpio, `npm test` con 86 archivos y 1041 tests en verde,
working tree limpio en `main` (HEAD `e3e7e8b`). Los cuatro defectos son
silenciosos: no los agarra ningún test ni el typecheck.

### Decisiones de producto ya tomadas

Las dos decisiones que no son de implementación quedan cerradas acá para que no
se rediscutan durante el diseño:

1. **La coma decimal se acepta.** El presupuesto y las Reglas van a aceptar
   `100,50` y `1,5` como en Finanzas, además de rechazar la ambigüedad del
   punto. Hoy el presupuesto rechaza la coma con motivo `no_numero` mientras
   Finanzas la acepta: el mismo panel se comporta distinto según la pantalla, y
   la coma es como se escribe la plata en castellano.
2. **Lo ya guardado se señala, no se corrige.** Un techo guardado en 1 donde iba
   1000 sigue roto después de arreglar el parseo. Entra en alcance detectarlo
   por dos vías (un script de auditoría y un aviso en la UI de Reglas) y queda
   **fuera de alcance** cualquier corrección automática o migración de datos: un
   `budget_max = 1` no se distingue con certeza de un techo de un euro escrito a
   propósito, así que la decisión es de una persona.

### Consecuencia pendiente que este arreglo arrastra

El `type="number"` de `FormularioPresupuesto.tsx:48` es **parte del arreglo, no
un detalle**: si el parseo pasa a aceptar la coma, un `type="number"` la
descarta en la mayoría de los browsers antes de que el parseo la vea, y la
decisión 1 quedaría escrita pero sin efecto en la pantalla. El campo tiene que
pasar a texto con `inputMode="decimal"`, y eso arrastra la validación de rango
que hoy delega al browser (`min`/`max`/`step`) hacia el parseo compartido.

## Bug Analysis

### Current Behavior (Defect)

Los importes de abajo salen de correr los módulos reales con `tsx`, no de leer el
código.

**Diálogo de presupuesto**

1.1 WHEN se escribe `1.000` en el campo de presupuesto diario THEN el sistema lo
acepta como 1 EUR (`parsearPresupuesto('1.000', 5000)` devuelve
`{"ok":true,"valor":1}`), no muestra ningún aviso y termina aplicando
`campos: { daily_budget: '100' }` sobre la campaña real de Meta.

1.2 WHEN se escribe cualquier otro texto con un punto y tres cifras a la derecha
THEN el sistema lo acepta como un importe mil veces menor: `1.500` → 1.5,
`2.000` → 2, `10.000` → 10.

1.3 WHEN el importe corrompido cae dentro del rango THEN ningún corte lo agarra:
`MINIMO_EUR` es 0,01, así que 1 pasa el mínimo, el techo y el control de dos
decimales.

1.4 WHEN se escribe un importe con coma decimal THEN el sistema lo rechaza:
`parsearPresupuesto('100,50', 5000)` y `parsearPresupuesto('1,5', 5000)`
devuelven `{"ok":false,"motivo":"no_numero"}`, con el texto «el importe tiene que
ser un número», mientras `parsearMonto('100,50')` da `{"ok":true,"valor":100.5}`.

1.5 WHEN se escribe una agrupación de miles que no es ambigua THEN el sistema
también la rechaza con `no_numero`: `1.000.000` y `1.234,56` no se pueden
escribir en el campo, aunque Finanzas los lee como 1000000 y 1234,56.

**Reglas**

1.6 WHEN se escribe `1.000` en el valor de la acción, en el techo o en el piso de
una regla THEN `numeroDeTexto` devuelve 1 y el payload guarda 1
(`ReglasView.tsx:601`, `:614`, `:615`, `:711`, `:713`, `:714`): una regla que
tenía que subir el presupuesto a 1000 lo pone en 1, y un techo de `1.000` queda
en 1, más bajo que casi cualquier presupuesto real, así que la regla no puede
subir nada nunca.

1.7 WHEN se escribe `1.000` en el valor de una condición THEN se guarda
«métrica > 1» (`ReglasView.tsx:652`, `:722`). En una regla de pausar, un umbral
mil veces más bajo pausa casi todo lo que pase el filtro de alcance: es la misma
consecuencia que el bug del campo vacío que ya se arregló, con otra entrada.

1.8 WHEN `problemaAccion` valida un valor que ya viene corrompido THEN da el
visto bueno (`ReglasView.tsx:601`): ve 1, que es finito y mayor a 0, así que no
hay nada que reportar.

1.9 WHEN se escribe `1.000` en el límite de ejecuciones diarias THEN
`Number('1.000')` da 1 y `Number.isInteger(1)` es `true`, así que pasa la
validación «entero mayor a 0» (`ReglasView.tsx:674`) y se guarda **1** ejecución
diaria en lugar de 1000 (`:719`).

1.10 WHEN cualquiera de los casos 1.1 a 1.9 ocurre THEN el valor corrompido queda
guardado y se muestra como si fuera el que se escribió: no hay error, ni borde
rojo, ni entrada en ningún log. Los campos son tipeables a mano
(`inputMode="decimal"` en `ReglasView.tsx:2083`, `:2106`, `:2118`, `:2231`;
`inputMode="numeric"` en `:2277`, `:2359`, `:2377`), y `inputMode` es una pista
de teclado, no validación.

**Chip de cascada**

1.11 WHEN se pasa el mouse por el botón «Limpiar el filtro de cascada» THEN el
color no cambia: `hover:text-good-100` (`ChipCascada.tsx:53`) apunta a un tono
que `tailwind.config.ts` no define (la escala `good` va de 200 a 600), no se
emite ninguna regla de CSS y el ícono se queda en el `text-good-300` de base.

### Expected Behavior (Correct)

**Un solo parseo, el criterio de Finanzas**

2.1 WHEN se escribe un texto donde el punto no se puede leer sin ambigüedad
(`1.000`, `1.500`, `2.000`, `10.000`) en cualquiera de los campos de las
cláusulas 1.1, 1.6, 1.7 y 1.9 THEN el sistema SHALL rechazarlo, SHALL explicar la ambigüedad
ofreciendo las dos escrituras posibles (como hace `parsearMonto`: «"1.000" se
puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir
1») y SHALL NOT guardar ni aplicar ningún valor.

2.2 WHEN se escribe un importe con coma decimal (`100,50`, `1,5`) en el campo de
presupuesto THEN el sistema SHALL aceptarlo como 100,50 y 1,5, igual que
Finanzas (decisión 1).

2.3 WHEN se escribe una agrupación de miles que no es ambigua (`1.000.000`,
`1.234,56`) THEN el sistema SHALL aceptarla como 1000000 y 1234,56.

2.4 WHEN el mismo texto se escribe en Finanzas, en el diálogo de presupuesto y en
un campo numérico de Reglas THEN los tres SHALL dar el mismo veredicto sobre si
es un número y cuál es, porque SHALL usar un único parseo compartido. Un cuarto
parseo propio no es una implementación aceptable de este requisito.

2.5 WHEN la notación que se escribe es exponencial, hexadecimal o lleva signo
`+` (`1e3`, `0x10`, `+5`) THEN el sistema SHALL rechazarla, **aunque hoy la
acepte**: `parsearPresupuesto` devuelve hoy 1000, 16 y 5 para esos tres textos.
Es una diferencia deliberada respecto del comportamiento actual, no un descuido:
el criterio de un campo de plata es «sólo números, coma o punto», y nadie tipea
`0x10` en un presupuesto queriendo decir 16 euros. En la dirección contraria y
también a propósito, el texto que trae un símbolo de moneda o espacios pegados de
una factura o de Excel (`€5`, `1 000` con espacio fino o duro) SHALL pasar a
aceptarse limpiando el ruido, aunque hoy se rechace con `no_numero`: es lo que ya
hace Finanzas y va con la decisión 1.

**Reglas**

2.6 WHEN el valor de la acción, el techo o el piso de una regla no se puede leer
sin ambigüedad THEN el sistema SHALL bloquear el guardado con un mensaje que
nombre el campo y explique la ambigüedad, y `payloadDeForm` SHALL NOT armar
ningún payload con el valor corrompido.

2.7 WHEN el valor de una condición no se puede leer sin ambigüedad THEN el
sistema SHALL bloquear el guardado nombrando la condición como ya lo hace para
el valor vacío y el no-número (`El valor de {métrica} (condición N) no es un
número: «...»`).

2.8 WHEN se escribe `1.000` en el límite de ejecuciones diarias THEN el sistema
SHALL rechazarlo por ambiguo; WHEN se escribe `1000` THEN SHALL guardar 1000; y
WHEN se escribe algo que no es entero (`1,5`) THEN SHALL seguir rechazándolo con
el mensaje de entero mayor a 0. La validación y el armado del payload SHALL usar
el mismo parseo, no `Number()` crudo.

2.9 WHEN `problemaAccion` valida un campo cuyo texto es ambiguo THEN SHALL
reportar el problema del **texto**, no evaluar el número ya corrompido: hoy
valida 1 y lo aprueba.

**El campo de presupuesto**

2.10 WHEN la persona tipea una coma en el campo de presupuesto diario THEN el
campo SHALL conservar el carácter para que el parseo lo vea. Eso implica dejar de
usar `type="number"` (que descarta la coma en la mayoría de los browsers) y pasar
a un input de texto con `inputMode="decimal"`.

2.11 WHEN el campo de presupuesto deja de ser `type="number"` THEN el rango que
hoy delega al browser (`min={MINIMO_EUR}`, `max={techoEur}`, `step={0.01}`) SHALL
quedar cubierto por el parseo y por los motivos que ya existen
(`bajo_el_minimo`, `sobre_el_techo`, `mas_de_dos_decimales`), sin perder ningún
rechazo que hoy hace el browser.

**Lo ya guardado (decisión 2)**

2.12 WHEN se corre el script de auditoría THEN SHALL listar los valores
guardados sospechosos de venir de este bug — los importes absolutos de
presupuesto (`action_value` con unidad EUR, `budget_max`, `budget_min`) y los
umbrales de condiciones de importe por debajo de un umbral que el script
documente — y SHALL NOT modificar ninguna fila.

2.13 WHEN el script reporta un valor THEN SHALL presentarlo como **sospechoso y
no como error**, porque un techo de 1 EUR escrito a propósito es indistinguible
de un `1.000` corrompido. Por el mismo motivo, `max_runs_per_day = 1` SHALL
quedar declarado explícitamente como no detectable: 1 ejecución diaria es un
valor legítimo y frecuente.

2.14 WHEN una regla guardada tiene un valor sospechoso THEN la UI de Reglas SHALL
señalarlo donde se lo ve, de forma que la persona lo confirme o lo corrija a
mano, y SHALL NOT corregirlo sola ni impedir que la regla siga funcionando.

**Chip de cascada**

2.15 WHEN se pasa el mouse por el botón «Limpiar el filtro de cascada» THEN el
ícono SHALL cambiar a un tono que exista en la escala `good` (el más claro
definido es `good-200`), y el CSS compilado SHALL contener el selector
correspondiente.

### Unchanged Behavior (Regression Prevention)

**Diálogo de presupuesto**

3.1 WHEN se escribe un importe sin separadores (`1000`, `25`, `0,01` una vez que
la coma se acepta) THEN el sistema SHALL SEGUIR aceptándolo con el mismo valor
que hoy.

3.2 WHEN el campo de presupuesto está vacío o tiene sólo espacios THEN el sistema
SHALL SEGUIR devolviendo el motivo `vacio` con el texto «falta el importe del
presupuesto», el diálogo SHALL SEGUIR bloqueando Ejecutar y el campo SHALL SEGUIR
sin pintarse de rojo: no está mal escrito, está sin escribir.

3.3 WHEN el importe está bajo `MINIMO_EUR`, sobre el techo de la cuenta o tiene
más de dos decimales THEN el sistema SHALL SEGUIR rechazándolo con los motivos
`bajo_el_minimo`, `sobre_el_techo` y `mas_de_dos_decimales` y con los mismos
textos en castellano que hoy devuelve `textoDeMotivo`.

3.4 WHEN `techoEur` no es un número THEN el importe SHALL SEGUIR rechazándose con
motivo `sobre_el_techo`, que es lo que hoy consigue la negación
`!(n <= techoEur)`.

3.5 WHEN el formulario acepta un importe THEN el Endpoint_Acciones SHALL SEGUIR
aceptando exactamente los mismos importes, y `aplicarPresupuesto` SHALL SEGUIR
mandando a Meta `Math.round(eur * 100)` en unidades.

3.6 WHEN el importe se rechaza THEN el texto del borde rojo del campo y el texto
que el diálogo muestra al lado del botón Ejecutar deshabilitado SHALL SEGUIR
saliendo del mismo catálogo, para que no puedan contradecirse.

**Reglas**

3.7 WHEN un campo de condición queda vacío THEN el sistema SHALL SEGUIR
bloqueando el guardado con el mensaje que explica que un valor vacío se guardaría
como 0 y no como «sin límite». Este es un arreglo anterior del mismo formulario y
no se puede perder: sin él, «gasto mayor que ␣» se guardaba como «gasto > 0», que
en una regla de pausar significa pausá todo.

3.8 WHEN se escribe `1,5` en un campo numérico de Reglas THEN SHALL SEGUIR
leyéndose como 1,5. La coma ya funciona acá y es el otro arreglo anterior de la
misma función.

3.9 WHEN una condición usa un 0 escrito a propósito («ventas <= 0») THEN SHALL
SEGUIR siendo posible guardarla: el vacío devuelve NaN justamente para que no se
confunda con un 0 deliberado.

3.10 WHEN el valor de la acción, el techo, el piso o el límite de ejecuciones
diarias quedan vacíos THEN SHALL SEGUIR viajando como `null` y nunca como 0
(`nuloSiNaN`).

3.11 WHEN se guarda una regla THEN SHALL SEGUIR validándose todo lo demás igual:
nombre obligatorio, nombre único por cuenta (el UNIQUE de la migración 021), la
ventana horaria vía `lib/ads/reglas/coherencia`, la coherencia entre condiciones,
el cooldown, y los avisos de porcentaje («un factor menor a 100 BAJA el
presupuesto», «para bajar a la mitad va 50%»).

3.12 WHEN el techo y el piso son los dos válidos y el techo es menor al piso THEN
SHALL SEGUIR reportándose que no hay ningún valor que satisfaga los dos.

**Finanzas**

3.13 WHEN se carga o edita un monto en Finanzas THEN `parsearMonto` SHALL SEGUIR
dando exactamente los mismos veredictos que hoy, incluidos los mensajes de
error, y sus 12 tests SHALL SEGUIR pasando sin modificarse. Si el parseo se
comparte, Finanzas es el lado que no puede moverse.

**Chip de cascada y estilos**

3.14 WHEN se renderiza el chip de cascada THEN SHALL SEGUIR usando sin cambios el
resto de sus clases: el borde `good-500/30`, el fondo `good-500/10`, el texto
`good-200`, el `hover:bg-good-500/20` y el anillo de foco
`focus-visible:ring-good-500/60`; y SHALL SEGUIR mostrando el texto por nivel, el
recorte del nombre a 40 caracteres, el `+N` de los ids restantes y el `−N` de los
descartados.

3.15 WHEN se compila el CSS THEN las demás clases estáticas del panel SHALL
SEGUIR emitiendo reglas: `hover:text-good-100` es la única que hoy no emite nada
sobre las 390 clases barridas en `app/`, `components/` y `lib/`.

**El repo**

3.16 WHEN se corre `npx tsc --noEmit` y `npm test` después del arreglo THEN SHALL
SEGUIR dando limpio y en verde: 86 archivos y 1041 tests era el estado en el
commit `e3e7e8b`, así que cualquier fallo nuevo es de este cambio.
