# Diseño del arreglo: parseo de montos en Anuncios

## Overview

El bug es uno y tiene cuatro copias: `1.000` se lee como 1 en el diálogo de
presupuesto, en los valores de Reglas, en las condiciones de Reglas y en el
límite de ejecuciones diarias. Las tres copias de Anuncios usan `Number()` (o un
`replace(',', '.')` seguido de `Number()`), y `Number('1.000')` es 1: correcto
para JavaScript, catastrófico para un campo de plata escrito en castellano.

El arreglo tiene tres piezas y una cuarta suelta:

1. **Un solo parseo compartido.** El criterio correcto ya existe en
   `parsearMonto` (Finanzas): cuando el texto es ambiguo no elige, rechaza y
   explica las dos lecturas. Se mueve a `lib/monto.ts` y se le extrae un
   **núcleo sin política** (`leerNumeroEscrito`), que es lo que las tres copias
   de Anuncios van a llamar. Finanzas queda igual, byte por byte, incluidos sus
   12 tests (cláusula 3.13).
2. **Los cortes propios de cada pantalla se quedan donde están.** El presupuesto
   sigue teniendo mínimo, techo y dos decimales, con su enum de motivos y su
   catálogo de textos, porque el borde rojo del campo y el bloqueo de Ejecutar
   salen de ahí (3.6). Reglas sigue teniendo sus mensajes que nombran el campo.
   Lo único que se comparte es el veredicto sobre qué número dice el texto,
   que es exactamente lo que pide 2.4.
3. **El tipo de retorno cambia en Reglas, y ese es el punto.** `numeroDeTexto`
   devuelve hoy `number` con NaN como única señal de fallo, así que la
   validación no puede distinguir «vacío» de «ilegible» de «ambiguo» y sólo
   puede preguntarle `isFinite` al número **ya corrompido** (1.8). Pasar a un
   resultado con estado es lo que hace posible 2.9.
4. **El token de Tailwind** (`hover:text-good-100` → `good-200`) es una línea, y
   lo interesante es cómo se verifica que no vuelva a pasar.

Lo ya guardado no se corrige: se señala, por un script de auditoría de sólo
lectura y por un aviso en la lista de Reglas, los dos alimentados por el **mismo
predicado** para que no puedan discrepar (decisión 2 del bugfix).

## Glossary

- **Bug_Condition (C)**: el texto tiene un punto que no se puede leer sin
  ambigüedad, y el sistema elige una lectura en silencio en lugar de preguntar.
- **Property (P)**: el comportamiento correcto para C: rechazo con el mensaje que
  ofrece las dos escrituras posibles, y ningún valor guardado ni aplicado.
- **Preservation**: para todo texto que no cumple C, el veredicto no cambia,
  salvo las excepciones declaradas en 2.2, 2.3 y 2.5.
- **Nucleo_De_Lectura** (`leerNumeroEscrito` en `lib/monto.ts`): la función que
  decide **qué número dice un texto**, sin ninguna política de rango, signo ni
  decimales. Es lo único que los cuatro sitios comparten.
- **Politica**: los cortes propios de cada pantalla (mínimo, techo, cantidad de
  decimales, signo, entero) que se aplican sobre el resultado del núcleo. No se
  comparten: cada campo tiene los suyos y sus propios textos.
- **Motivo** (`MotivoPresupuesto`): el enum cerrado de por qué un texto no es un
  presupuesto. Sigue existiendo porque el borde rojo y el bloqueo de Ejecutar
  salen de su catálogo (3.6).
- **Catalogo_De_Motivos** (`textoDeMotivo`): el `Record` completo motivo → texto
  en castellano. Sumar un motivo sin su mensaje rompe la compilación, y eso se
  conserva.
- **Campo_Numerico**: el resultado del parseo de un campo de Reglas. Tres
  estados (`vacio`, `ok`, `error`) en lugar de un `number` con NaN.
- **Texto_Ambiguo**: un texto que cumple C. `parsearMonto` ya los detecta y ya
  produce el mensaje de las dos lecturas.
- **Sospecha**: un valor ya guardado que **podría** venir de este bug. Nunca es
  un error: 2.13 lo declara indistinguible de un valor escrito a propósito.
- **Umbral_De_Sospecha**: el corte en EUR por debajo del cual un importe
  guardado se reporta. Vive en un solo módulo, compartido por el script y la UI.

## Bug Details

### Bug Condition

El bug se manifiesta cuando el texto de un campo numérico tiene **un solo
punto con exactamente tres dígitos a la derecha**. Esa forma es agrupación de
miles para quien escribe en castellano y un decimal para `Number()`, y las
cuatro implementaciones actuales eligen la segunda sin avisar.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input de tipo { texto: string, campo: CampoNumericoDelPanel }
  OUTPUT: boolean

  s := limpiarRuido(input.texto)          // espacios, €, $, espacio fino y duro

  RETURN cuentaDe(s, '.') = 1
         AND cuentaDe(s, ',') = 0
         AND longitud(izquierdaDelPunto(s)) BETWEEN 1 AND 3
         AND longitud(derechaDelPunto(s)) = 3
         AND todosDigitos(izquierdaDelPunto(s))
         AND todosDigitos(derechaDelPunto(s))
END FUNCTION
```

### La regla implementada es más ancha que C, a propósito

`parsearMonto` no mira cuántos dígitos hay a la izquierda: su corte es
`derecha.length === 3 && corte > 0`. Entonces `1000.000` y `12345.678`
(cuatro o más dígitos a la izquierda) también se rechazan como ambiguos, y no
entran en la C que dejó la fase de requisitos.

Se conserva la regla ancha, no se angosta a 1–3 dígitos:

- 3.13 congela los veredictos de `parsearMonto`. Angostar la regla haría que
  `parsearMonto('1000.000')` pase de rechazar a devolver 1000, que es
  exactamente el tipo de cambio que esa cláusula prohíbe.
- `1000.000` tampoco tiene una lectura sin ambigüedad: como agrupación está mal
  formado (el primer grupo tendría cuatro dígitos), y como decimal es
  `1000,000`. Preguntar es la respuesta correcta para los dos.

La consecuencia se declara acá y se verifica como excepción en el test de
preservación: **los textos `^\d{4,}\.\d{3}$` pasan a rechazarse por ambiguos**,
igual que los de C, aunque estén fuera de la C escrita en 2.1. Corrido contra el
código de hoy: `parsearPresupuesto('1000.000', 5000)` devuelve
`{"ok":true,"valor":1000}` —una aceptación que se pierde— y
`parsearPresupuesto('12345.678', 5000)` devuelve `sobre_el_techo`, que se
mantiene como rechazo pero cambia de motivo.

### Examples

Los valores de la columna «hoy» salen de correr los módulos con `tsx`, no de
leer el código.

| Texto | Campo | Hoy | Con el arreglo |
|---|---|---|---|
| `1.000` | presupuesto diario | `{ok:true,valor:1}` → `daily_budget: '100'` en Meta | rechazo: «"1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1» |
| `1.500` | presupuesto diario | `{ok:true,valor:1.5}` | rechazo con las dos lecturas (1500 / 1,5) |
| `1.000` | techo de una regla | `budgetMax: 1` guardado; la regla no puede subir nada nunca | el guardado se bloquea nombrando el techo |
| `1.000` | valor de una condición | `gasto > 1` guardado; en una regla de pausar, pausa casi todo | el guardado se bloquea nombrando la condición |
| `1.000` | límite de ejecuciones diarias | `Number('1.000')` = 1, `isInteger(1)` = true → 1 ejecución | rechazo por ambiguo antes de mirar si es entero |
| `1000.000` | cualquiera | 1000 (fuera de la C escrita, ver arriba) | rechazo por ambiguo |
| `100,50` | presupuesto diario | `{ok:false,motivo:'no_numero'}` | 100,5 (2.2) |
| `1.000.000` | presupuesto diario | `no_numero` | 1000000 (2.3) |
| `1.234,56` | presupuesto diario | `no_numero` | 1234,56 (2.3) |
| `€5`, `1 000` | presupuesto diario | `no_numero` | 5 y 1000, limpiando el ruido (2.5) |
| `1e3`, `0x10`, `+5` | presupuesto diario | 1000, 16 y 5 | rechazo (2.5) |
| `1000` | presupuesto diario | 1000 | 1000, sin cambio (3.1) |
| `1,5` | valor de una condición | 1,5 | 1,5, sin cambio (3.8) |
| `` (vacío) | condición | bloqueo con el mensaje del vacío | igual, textual (3.7) |

## Expected Behavior

El comportamiento correcto para todo texto de C, en las cuatro pantallas:

```
FUNCTION expectedBehavior(resultado, texto)
  INPUT: resultado, el retorno del parseo del campo para un texto de C
  OUTPUT: boolean

  RETURN resultado.aceptado = false
     AND resultado.mensaje CONTIENE sinElPunto(texto)          // "1000"
     AND resultado.mensaje CONTIENE truncadoEnElPunto(texto)   // "1"
     AND resultado.valorGuardado = NINGUNO
     AND resultado.valorAplicado = NINGUNO
END FUNCTION
```

Las dos lecturas van en el mensaje y no una sola: el valor del rechazo está en
que la persona elija, no en que se entere de que algo salió mal (2.1).

### Preservation Requirements

**Comportamientos que no cambian:**

- Finanzas: `parsearMonto` da los mismos veredictos y los mismos mensajes de
  error, y sus 12 tests pasan **sin editarse** (3.13).
- Presupuesto: `vacio` con «falta el importe del presupuesto» y sin borde rojo
  (3.2); `bajo_el_minimo`, `sobre_el_techo` y `mas_de_dos_decimales` con los
  mismos textos (3.3); un `techoEur` que no es número sigue rechazando todo con
  `sobre_el_techo` (3.4); el importe aceptado sigue viajando como `budgetEur` y
  llegando a Meta como `Math.round(eur * 100)` (3.5); el borde rojo y el texto
  al lado de Ejecutar siguen sin poder contradecirse (3.6).
- Reglas: el mensaje del valor vacío de una condición, textual (3.7); la coma
  decimal (3.8); el 0 escrito a propósito (3.9); el vacío que viaja como `null`
  y nunca como 0 (3.10); todo el resto de la validación —nombre único, ventana
  horaria, coherencia entre condiciones, cooldown, avisos de porcentaje— (3.11);
  el techo menor al piso (3.12).
- Chip de cascada: el resto de sus clases y todo su texto (3.14).
- El repo: `npx tsc --noEmit` limpio y `npm test` en verde (3.16).

**Alcance:**

Todo texto que no cumple C debería quedar completamente inafectado, con **siete
familias de excepción declaradas**: cuatro que salen de las cláusulas (2.2, 2.3 y
2.5), una de la regla ancha de arriba, una que aparece al leer el núcleo y una
séptima que la tarea 2 midió y que se decidió en la 3.2. La lista cerrada, que es
la que el test de preservación usa como predicado:

| # | Familia | Cláusula | Hoy | Con el arreglo |
|---|---|---|---|---|
| a | El texto tiene una coma | 2.2 | siempre `no_numero` (`Number` no lee la coma) | se lee como en Finanzas: puede aceptarse, o rechazarse con otro motivo |
| b | El texto tiene más de un punto | 2.3 | `no_numero` | agrupación de miles si está bien formada |
| c | Tras limpiar el ruido no cumple `^-?[\d.]*$` | 2.5 | `1e3`→1000, `0x10`→16, `0b11`→3, `0o17`→15, `+5`→5 | rechazo |
| d | El texto trae `€`, `$` o espacios que `Number` no tolera | 2.5 | `no_numero` | se limpia el ruido y se lee el número |
| e | `^\d{4,}\.\d{3}$` | ver arriba | `1000.000`→1000 aceptado; `12345.678`→`sobre_el_techo` | rechazo por ambiguo: pierde una aceptación en el primer caso y cambia de motivo en el segundo |
| f | No hay ningún dígito y el núcleo lo resuelve como 0 (`.`, `€.`) | — | `no_numero` | `bajo_el_minimo`: sigue siendo rechazo, cambia el mensaje |
| g | `^-\d+\.\d{3}$` — la misma forma que C y que (e), con signo | ver abajo | `-1.000`→`bajo_el_minimo` (leído como −1) | rechazo por ambiguo: sigue siendo rechazo y cambia de motivo |

`0b11` y `0o17` no están nombrados en 2.5 pero caen en su criterio explícito
(«sólo números, coma o punto»); se listan acá para que la excepción sea una
familia cerrada y no una lista de tres literales. Verificado corriendo el módulo:
hoy `0b11` da 3 y `0o17` da 15, los dos aceptados como importe.

La familia (f) es de un solo texto en la práctica y no la pide ninguna cláusula:
aparece de leer el núcleo, que resuelve `'.'` como `0` (entero vacío → `'0'`,
decimales vacíos) donde `Number('.')` daba `NaN`. Se declara en lugar de
corregirse porque la corrección —que el núcleo rechace un texto sin dígitos—
cambiaría el mensaje de `parsearMonto('.')`, y 3.13 congela los mensajes.

### La familia (g): el signo entra en la ambigüedad

La séptima familia no estaba en el diseño original y no la encontró nadie
leyendo: la midió la **tarea 2**, comparando los dos oráculos congelados contra
una simulación del núcleo. Se declara acá porque una excepción no declarada no
existe: si no está en esta tabla, la Property 2 la reporta como contraejemplo en
la 3.8, que es exactamente para lo que la propiedad está escrita al revés.

**La evidencia, tal como la dejó la tarea 2:**

- Lado presupuesto: 404.661 combinaciones de texto × techo, 14.870 flips. Todos
  caen en C o en las seis familias **menos 64**, que se describen exactamente con
  `^-\d+\.\d{3}$`. El caso concreto:
  `parsearPresupuesto('-1.000', 100)` hoy → `bajo_el_minimo`, con el arreglo →
  `ambiguo`.
- Lado Reglas: 358.206 textos, 6.915 flips, todos declarados **menos 56**, la
  misma clase. `numeroDeTexto('-1.000')` hoy → `-1`; con el arreglo, `error` con
  motivo `ambiguo`.

`-1.000` no cumple `isBugCondition` —a la izquierda del punto está `-1` y C pide
que sean todos dígitos— y no cae en ninguna de las seis familias: no tiene coma,
no tiene dos puntos, `^-?[\d.]*$` lo acepta, no trae ruido, `^\d{4,}\.\d{3}$` no
lo matchea y tiene dígitos. Queda en el hueco entre C y (e) por el signo, y nada
más que por el signo.

**La decisión: `-1.000` ES ambiguo** (es −1000 o −1) y el núcleo lo rechaza como
tal. El motivo es que la alternativa deja el bug vivo para los negativos: si el
núcleo no mirara el signo, una condición «ganancia < -1.000» se seguiría
guardando como −1, que es el mismo modo de falla que este spec vino a arreglar y
el mismo mensaje de error que ya está escrito para el caso positivo. Un campo de
número no adivina, y eso no depende del signo.

La regex de la familia lleva el `-` **obligatorio** (`^-\d+\.\d{3}$` y no
`^-?\d+\.\d{3}$`) a propósito: sin signo esa forma ya está cubierta por C
(`^\d{1,3}\.\d{3}$`) y por (e) (`^\d{4,}\.\d{3}$`), y una familia que se solapa
con otras dos es justamente el predicado ensanchado contra el que van las dos
guardas de §Preservation Checking.

Consecuencia declarada, que es la misma forma que (e) y (f): **un texto de
`^-\d+\.\d{3}$` sigue siendo un rechazo y cambia de motivo**. En el presupuesto
pasa de `bajo_el_minimo` a `ambiguo`; en Reglas, de leerse como −1 a bloquear el
guardado. Ninguna aceptación se pierde, porque ningún negativo se aceptaba.

## Hypothesized Root Cause

1. **Cuatro parseos, tres de ellos `Number()`.** La causa es de arquitectura, no
   de una línea: mientras haya cuatro implementaciones, arreglar una no arregla
   nada. `Number('1.000') === 1` es correcto por spec de JavaScript, así que no
   hay ningún bug que buscar dentro de las funciones: el bug es haber usado
   `Number` como parseo de un campo de plata en castellano.

2. **`Number` como validador: la señal de fallo se confunde con datos.**
   `Number('')` es 0 y `Number('1,5')` es NaN, así que NaN tiene que hacer de
   «vacío», «ilegible» y «ambiguo» al mismo tiempo. `numeroDeTexto` devuelve NaN
   para el vacío justamente para poder distinguirlo del 0 deliberado, y con eso
   agotó la única señal que el tipo `number` le daba.

3. **El tipo de retorno no puede llevar el motivo, así que la validación se
   corre al número corrompido.** `problemaAccion` recibe 1 (finito, mayor a 0) y
   no tiene forma de saber que el texto era `1.000`: es literalmente la causa de
   1.8, y es por lo que 2.9 pide que se valide el **texto**.

4. **El rango delegado al browser da falsa cobertura.** `type="number"` con
   `min`/`max`/`step` parece validación y no lo es: `1.000` es un float válido y
   1 está dentro del rango, así que el browser no protesta. Peor: se come la
   coma antes de que cualquier parseo la vea, lo que haría que la decisión 1
   quedara escrita y sin efecto.

5. **El módulo correcto vive en una ruta del panel.** `parsearMonto` está en
   `app/(panel)/finanzas/monto.ts`, y ningún módulo de `lib/` puede importarlo
   sin invertir la dependencia. Esa es la razón estructural de que se escribieran
   copias en lugar de reutilizarlo, y es lo primero que el arreglo tiene que
   sacar del camino.

6. **Token de Tailwind: el JIT no valida nombres.** Una clase que no existe no
   emite CSS, no rompe el build y no aparece en ningún test. El defecto no es el
   token: es que no había ninguna forma de enterarse.

## Correctness Properties

### Property 1: Bug Condition — el texto ambiguo se rechaza y se explica en los cuatro campos

_For any_ texto que cumpla la Bug_Condition y para cualquiera de los cuatro
campos (presupuesto diario, valor/techo/piso de una regla, valor de una
condición, límite de ejecuciones diarias), el parseo compartido SHALL rechazarlo,
el mensaje SHALL contener las dos escrituras posibles (el número sin el punto y
el número truncado en el punto), y SHALL NOT existir ningún camino por el que ese
texto produzca un valor guardado o aplicado: ni `budgetEur` en el payload del
Endpoint_Acciones, ni `actionValue`/`budgetMax`/`budgetMin`/`maxRunsPerDay`, ni
el `value` de una condición.

**Validates: Requirements 2.1, 2.6, 2.7, 2.8, 2.9**

### Property 2: Preservation — el veredicto sólo cambia donde está declarado

_For any_ texto y cualquier techo positivo, si el veredicto de
`parsearPresupuesto` con el arreglo difiere del veredicto de la implementación
actual (congelada como oráculo en el test), entonces el texto cumple la
Bug_Condition o pertenece a una de las siete familias de excepción declaradas
(a–g de §Alcance). Fuera de esas familias, el resultado SHALL ser igual campo
por campo: el mismo `ok`, el mismo `valor` cuando se acepta y el **mismo
motivo** cuando se rechaza.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.13**

### Property 3: ningún payload lleva un número que el texto no dice

_For any_ `FormEstado` de Reglas, si `problema(f)` devuelve `null` entonces todos
los números de `payloadDeForm(f)` salen del mismo parseo que validó el texto:
cada campo vacío viaja como `null` y nunca como 0, y no existe un `FormEstado`
que habilite Guardar y produzca un payload con un número distinto del que su
texto dice.

**Validates: Requirements 2.6, 2.8, 3.9, 3.10**

### Property 4: el veredicto es el mismo en las tres pantallas

_For any_ texto, `parsearMonto` (Finanzas), `parsearPresupuesto` (Anuncios) y el
parseo de un campo de Reglas SHALL coincidir en si el texto nombra un número y en
cuál es. Pueden diferir en aceptar o rechazar ese número —cada pantalla tiene sus
propios cortes de rango, signo y decimales— pero no en qué número dice el texto.

**Validates: Requirements 2.4**

### Property 5: un rechazo siempre tiene un texto, y es el mismo en los dos lugares donde se muestra

_For any_ texto rechazado por `parsearPresupuesto`, el mensaje que pinta el borde
rojo del campo y el que aparece al lado del botón Ejecutar deshabilitado SHALL
ser la misma cadena no vacía, incluido el motivo nuevo de ambigüedad, que
interpola las dos lecturas y por lo tanto no puede salir de un `Record` de
textos fijos.

**Validates: Requirements 3.6**

### Property 6: toda clase de color literal del panel existe en la paleta

_For any_ clase de la forma `{prefijo:}?{propiedad}-{escala}-{tono}` escrita
literalmente en `app/`, `components/` o `lib/`, el tono SHALL existir en la
paleta de `tailwind.config.ts`. `hover:text-good-100` es la única que hoy no lo
cumple.

**Validates: Requirements 2.15, 3.14, 3.15**

### Property 7: la sospecha que ve la UI es la misma que reporta el script

_For any_ regla guardada, el conjunto de valores que el aviso de la UI marca como
sospechosos SHALL ser exactamente el que el script de auditoría lista para esa
regla, porque los dos llaman al mismo predicado con el mismo umbral. Y para todo
valor sospechoso, el texto ambiguo reconstruido SHALL ser exacto:
`valor.toFixed(3)` es el texto que `Number()` habría leído como ese valor.

**Validates: Requirements 2.12, 2.13, 2.14**

## Fix Implementation

### Decisión 1 — dónde vive el parseo compartido

**`app/(panel)/finanzas/monto.ts` se mueve a `lib/monto.ts`, con su test.**

Descartado dejarlo donde está e importarlo desde `lib/`:

- Ningún módulo de producción de `lib/` importa de `app/` hoy. Los tres únicos
  imports en esa dirección son de archivos de test (`lib/ingest/apply.test.ts`,
  `lib/orders/webhook.test.ts`, `lib/queries/ads.zonas.test.ts`). Invertir la
  dependencia en producción es un precedente que no hace falta abrir para este
  arreglo.
- `lib/ads/presupuesto.ts` está documentado como puro y lo comparten el cliente,
  el schema del Endpoint_Acciones y el ejecutor de reglas. Hacerlo depender de un
  segmento de ruta significa que mover o renombrar la ruta de Finanzas rompe el
  API de Anuncios.
- El especificador quedaría `@/app/(panel)/finanzas/monto`: un grupo de rutas de
  Next con paréntesis dentro de un import de un módulo de dominio.

Descartado re-exportar desde `lib/monto.ts` un archivo que sigue viviendo en
`app/`: es la misma dependencia invertida con un salto más, y deja que el
archivo que todos importan no sea el archivo donde está el código.

**El nombre del archivo no cambia**, y no es un detalle: `monto.test.ts` importa
`from './monto'` y nada más, así que mover los dos archivos juntos a `lib/` deja
el test **idéntico byte por byte**, que es la forma literal de cumplir 3.13. Un
rename obligaría a editar la única línea de import del test que la cláusula
congela. El único import que se actualiza es el de `FinanzasView.tsx`:
`'./monto'` → `'@/lib/monto'`.

**Se extrae el núcleo, en el mismo archivo:**

```ts
// lib/monto.ts

export type MotivoNumero =
  | 'vacio'        // no quedó nada después de limpiar el ruido ("€", "  ")
  | 'caracteres'   // hay algo que no es dígito, coma ni punto (1e3, 0x10, +5, abc)
  | 'ilegible'     // los separadores no forman ningún número (1.00.000, 1,2,3)
  | 'ambiguo';     // C: un punto con exactamente 3 dígitos a la derecha

export type NumeroEscrito =
  | { ok: true; valor: number; decimales: number }
  | { ok: false; motivo: Exclude<MotivoNumero, 'ambiguo'> }
  | {
      ok: false;
      motivo: 'ambiguo';
      comoMiles: string;    // "1000"
      comoDecimal: string;  // "1"
      explicacion: string;  // la frase de las dos lecturas, ya armada
    };

/** Qué número dice un texto. SIN política: no mira rango, ni signo, ni cuántos
 *  decimales son demasiados, ni si el número es representable. Un negativo bien
 *  escrito vuelve como valor negativo, y 400 dígitos vuelven como Infinity:
 *  quien llama decide si eso le sirve. */
export function leerNumeroEscrito(raw: string): NumeroEscrito;
```

El núcleo es el cuerpo actual de `parsearMonto` desde el `test(/^[\d.,]+$/)`
hasta el `Number(...)`, con tres diferencias:

- Acepta un `-` inicial y devuelve el valor negativo, en lugar de rechazarlo con
  el mensaje de Finanzas. El signo es política: en Finanzas lo pone el tipo de
  movimiento, en un presupuesto es «bajo el mínimo» y en una condición
  («ganancia < -10») es legítimo.
- Devuelve `decimales` como cantidad, para que cada pantalla ponga su propio
  límite. `numeric(14,2)` en Finanzas y presupuesto, `numeric(16,4)` en las
  condiciones.
- **No chequea `Number.isFinite`**, y eso es a propósito aunque incomode: hoy
  `parsearMonto` mira los decimales **antes** de la finitud, así que un texto de
  400 dígitos con cuatro decimales devuelve «el monto lleva 2 decimales como
  máximo» y no «no se entiende el monto». Si el núcleo rechazara la finitud, ese
  mensaje cambiaría, y 3.13 no distingue entre entradas plausibles y absurdas.
  Cada política aplica `Number.isFinite` en la posición que su orden actual
  exige. Es el precio de congelar mensajes, y queda anotado en el tipo para que
  ningún consumidor lo dé por hecho.

`parsearMonto` queda como núcleo más política de Finanzas, **con el orden de
cortes intacto**, que es lo que preserva sus mensajes:

```ts
export function parsearMonto(raw: string): MontoParseado {
  const s = raw.replace(RUIDO, '');
  if (s.length === 0) return { ok: false, error: 'escribí un monto' };
  if (s.startsWith('-')) return { ok: false, error: 'el monto va sin el signo menos: …' };

  const n = leerNumeroEscrito(s);
  if (!n.ok) return { ok: false, error: errorDeLectura(n, raw) };   // mapea los 3 motivos a los textos de hoy
  if (n.decimales > 2) return { ok: false, error: 'el monto lleva 2 decimales como máximo' };
  if (!Number.isFinite(n.valor)) return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
  if (n.valor <= 0) return { ok: false, error: 'el monto tiene que ser mayor que cero' };
  if (n.valor >= MAX) return { ok: false, error: 'el monto es demasiado grande' };
  return { ok: true, valor: Math.round(n.valor * 100) / 100 };
}
```

El chequeo del signo sigue **antes** del de caracteres a propósito: hoy `-abc`
devuelve el mensaje del signo y no el de «sólo números, coma o punto», y ese
orden es parte de los veredictos que 3.13 congela.

### Decisión 2 — cómo conviven los dos contratos de retorno

El enum de motivos **no desaparece** y el catálogo **sigue siendo un `Record`
completo**. Lo que cambia es que el rechazo lleva su texto puesto:

```ts
// lib/ads/presupuesto.ts

export type MotivoPresupuesto =
  | 'vacio' | 'no_numero' | 'ambiguo'
  | 'bajo_el_minimo' | 'sobre_el_techo' | 'mas_de_dos_decimales';

export type PresupuestoParseado =
  | { ok: true; valor: number }
  | { ok: false; motivo: MotivoPresupuesto; texto: string };
```

`texto` sale de `textoDeMotivo(motivo)` para los cinco motivos de texto fijo, y
de `explicacion` del núcleo para `ambiguo`. `textoDeMotivo` **no cambia de
firma** —sigue siendo `(motivo) => string` y su test sigue pasando— y suma la
entrada `ambiguo` con un texto de respaldo genérico («el importe se puede leer de
dos formas: escribilo sin puntos de miles»), que es lo que se muestra si alguien
tiene un motivo sin el resultado a mano.

Por qué el campo `texto` y no seguir llamando a `textoDeMotivo` en cada
consumidor: 3.6 pide que el borde rojo y el bloqueo de Ejecutar no puedan
contradecirse, y hoy eso se consigue por convención (los dos llaman al mismo
catálogo). Con `texto` los dos leen **el mismo campo del mismo objeto**, así que
la contradicción deja de ser posible por construcción y no por cuidado. Es el
mismo argumento con el que `presupuestoDelDialogo` ya existe.

Alternativas descartadas:

- **Cambiar `textoDeMotivo` a `(fallo: PresupuestoParseado) => string`.** Rompe
  la firma que el test de `textoDeMotivo` fija y obliga a que todo consumidor
  tenga el objeto entero para pedir un texto. El catálogo dejaría de ser un
  `Record` recorrible, y ese `Record` es lo que hoy garantiza que ningún motivo
  quede sin mensaje.
- **Un `detalle?: string` opcional al lado del motivo, y que cada consumidor
  haga `detalle ?? textoDeMotivo(motivo)`.** Deja dos fuentes del texto y dos
  lugares donde olvidarse del `??`.
- **Que el motivo de ambigüedad no interpole y diga «escribilo sin puntos».** Es
  la salida fácil, y contradice 2.1: el valor del mensaje está en ofrecer las dos
  escrituras concretas.

**Composición y mapeo de motivos.** `parsearPresupuesto` llama al **núcleo**, no
a `parsearMonto`: la política de Finanzas (sin signo, mayor que cero, dos
decimales, tope de `numeric(14,2)`) no es la del presupuesto, y sus textos
tampoco. El orden de cortes se conserva:

```ts
if (texto.trim() === '') → vacio                       // 3.2, antes que nada
n := leerNumeroEscrito(texto)
if (!n.ok):
  'ambiguo'                        → { motivo: 'ambiguo', texto: n.explicacion }
  'caracteres' | 'ilegible' | 'vacio' → no_numero
if (!Number.isFinite(n.valor))     → no_numero          // 400 dígitos: hoy también no_numero
if (!(n.valor >= MINIMO_EUR))      → bajo_el_minimo     // 0, -0, -5 incluidos
if (!(n.valor <= techoEur))        → sobre_el_techo     // conserva 3.4 con techo NaN
if (Number(n.valor.toFixed(2)) !== n.valor) → mas_de_dos_decimales
```

Cinco detalles que este mapeo resuelve y que el test de preservación vigila. Los
tres primeros se verificaron corriendo el módulo de hoy:

- **Los negativos siguen siendo `bajo_el_minimo`**, no `no_numero`, porque el
  núcleo devuelve `-5` como número y el corte del mínimo lo agarra igual que hoy.
  Es por esto que el signo es política del llamador y no un rechazo del núcleo.
- **`-Infinity` sigue siendo `no_numero`**: tiene letras, así que el núcleo lo
  rechaza por `caracteres` antes de que el mínimo lo vea. Está pinneado en el
  test de hoy y sigue pasando.
- **`€` solo (o `' € '`) es `no_numero`, no `vacio`**: `trim()` no lo vacía, así
  que el primer corte no lo toma, y el núcleo devuelve `vacio` tras limpiar el
  ruido. Se mapea a `no_numero` porque es lo que devuelve hoy y porque el campo no
  está en blanco.
- **`'.'` solo pasa de `no_numero` a `bajo_el_minimo`**, y es la familia (f) de
  excepción: el núcleo lo resuelve como 0 donde `Number('.')` daba `NaN`. Sigue
  siendo un rechazo; cambia el mensaje. No se corrige por lo que dice §Alcance.
- **El corte de decimales se deja escrito como `Number(n.valor.toFixed(2)) !==
  n.valor`** y no como `n.decimales > 2`, aunque sean equivalentes para todo
  decimal bien formado: es la expresión que está hoy, y mantenerla saca del
  diseño la pregunta de si son equivalentes en los bordes de coma flotante.

**Consumidores.** Dos líneas:

- `FormularioPresupuesto.tsx:64`: `textoDeMotivo(parseo.motivo)` → `parseo.texto`.
- `GestorAnuncios.tsx:236`: `bloqueo: textoDeMotivo(importe.motivo)` →
  `bloqueo: importe.texto`.

### Decisión 3 — el input de presupuesto

`FormularioPresupuesto.tsx:49–52`: `type="number"` con `min={MINIMO_EUR}`,
`max={techoEur}` y `step={0.01}` pasa a texto con `inputMode="decimal"`. Los tres
atributos de rango **se borran**, no se reemplazan.

Que 2.11 esté cubierto no requiere código nuevo: `parsearPresupuesto` ya tiene
los tres cortes (`bajo_el_minimo` = `min`, `sobre_el_techo` = `max`,
`mas_de_dos_decimales` = `step`) y ya son los que deciden el borde rojo y el
bloqueo de Ejecutar. Lo que el browser aportaba encima era la flecha del spinner
y el teclado numérico en el celular; `inputMode="decimal"` devuelve lo segundo.

Ningún rechazo se pierde: los textos que un `type="number"` descartaba son un
**subconjunto** de los que el parseo rechaza. Y el que el browser aceptaba y no
debía (`1e3` es un valor válido para un input numérico) ahora se rechaza, que es
2.5. El patrón ya existe en el mismo panel: los cuatro campos de importe de
Reglas son `<input inputMode="decimal">` sin `type`.

**`GestorAnuncios.tsx:234 y :249`, revisados:**

- `:234` (`presupuestoDelDialogo`) sólo cambia el `bloqueo` como se dijo arriba.
  Sigue siendo la única lectura del texto para los tres consumidores.
- `:249` (`textoDeImporte`) **no se toca**, y el comentario sobre el round-trip
  sigue siendo cierto: `toFixed(2)` produce siempre exactamente dos decimales,
  así que ningún importe sembrado desde una celda puede caer en C, que necesita
  tres. Las dos propiedades de `presupuestoDialogo.test.ts` que cubren la ida y
  vuelta siguen pasando sin cambios.
- Lo que **no** se hace: pasar `textoDeImporte` a coma (`12,50`) para que el
  campo se vea como el resto del panel. Ahora que la coma se acepta el round-trip
  funcionaría igual, pero ninguna cláusula lo pide, el test pinnea `'12.50'`, y no
  hay ninguna falla visible para el usuario. Queda anotado como cambio cosmético
  disponible, no como parte de este arreglo.

### Decisión 4 — los tres sitios de Reglas

El cambio de tipo es el diseño, no un efecto colateral. `numeroDeTexto` deja de
devolver `number`:

```ts
// ReglasView.tsx — reemplaza numeroDeTexto (:574)
type CampoNumerico =
  | { estado: 'vacio' }
  | { estado: 'ok'; valor: number }
  | { estado: 'error'; motivo: MotivoNumero; detalle: string };

export function numeroDeCampo(s: string): CampoNumerico;
```

`vacio` sigue siendo un estado propio y distinto del 0, que es lo que 3.9 y 3.10
necesitan: el NaN de hoy existía sólo para eso, y ahora está nombrado.

`numeroDeCampo` sí pliega la finitud dentro de `error`, al revés que el
presupuesto: un `ok` de Reglas trae siempre un número finito, así que ningún call
site puede olvidarse del chequeo. Se puede hacer porque acá ninguna cláusula
congela el orden de los mensajes, y preserva el veredicto de hoy, donde un texto
que da Infinity ya cae en «no es un número».

`estado: 'vacio'` es sólo el campo en blanco (`''` o espacios). El `vacio` del
núcleo —un texto que era todo ruido, como `'€'`— cae en `error`, igual que en el
presupuesto y igual que hoy: el campo tiene algo escrito y ese algo no es un
número.

Se queda en `ReglasView.tsx` y se exporta para los tests, con el mismo criterio
que ya usa el repo: `presupuestoDelDialogo` vive en `GestorAnuncios.tsx` porque
es la forma del diálogo y no del dominio, y `problema`/`aplicadoA` ya se importan
desde `_nombres.test.ts`. Lo que es dominio —el núcleo— está en `lib/`.

**El mensaje.** Un helper único para las tres pestañas, porque 2.6 y 2.7 piden
que el problema nombre el campo y 2.1 pide que explique la ambigüedad:

```ts
function problemaDeCampo(nombre: string, bruto: string, r: ErrorDeCampo): string {
  return r.motivo === 'ambiguo'
    ? `${nombre}: ${r.detalle}`                       // «El techo: "1.000" se puede leer de dos formas: …»
    : `${nombre} no es un número: «${bruto}».`;       // el texto de hoy, intacto
}
```

Dos formas y no una: la segunda es literalmente el mensaje que hoy existe y que
2.7 cita, y la primera necesita la frase interpolada. `detalle` se reusa **tal
cual** del núcleo porque esa frase no nombra ningún sustantivo («"1.000" se puede
leer de dos formas: …»), así que sirve igual para un importe, para un ROI y para
un límite de ejecuciones. Es la única cadena que las tres pantallas comparten
palabra por palabra, y 2.1 pide exactamente eso.

**Los cinco call sites:**

- **`problemaAccion` (:601, :614, :615).** `actionValue`, `budgetMax` y
  `budgetMin` se parsean una vez cada uno al principio. `error` → mensaje que
  nombra el campo; `vacio` → los mensajes de hoy («Falta el valor de la
  acción.», «Falta el límite máximo (techo).»); `ok` → sigue a los cortes
  actuales (`<= 0`, los avisos de porcentaje, techo menor al piso) sobre
  `valor`. Con esto 2.9 queda cumplido por el tipo: ya no hay un `number` que
  validar, hay un texto que se leyó o no.
- **`problemaCondiciones` (:647, :652).** Se parsean las condiciones una sola vez
  al entrar. El vacío conserva su mensaje **textual** (3.7). El error usa
  `problemaDeCampo` con el nombre que ya se arma (`${METRICA_LABEL[c.metric]}
  (condición ${i + 1})`). Recién cuando todas dieron `ok`,
  `motivoCondicionesImposibles` recibe los valores ya parseados, así que deja de
  poder recibir un NaN.
- **`problemaProgramacion` (:671).** El `Number(tope)` crudo se va. `error` con
  motivo `ambiguo` → el mensaje de la ambigüedad; cualquier otro error, o un
  `ok` que no es entero mayor a 0 → el mensaje de hoy, textual, que es lo que
  2.8 pide para `1,5`.
- **`payloadDeForm` (:711, :713, :714, :719, :722).** `nuloSiNaN` se reemplaza
  por `valorONull(r) = r.estado === 'ok' ? r.valor : null`, y `maxRunsPerDay`
  deja de usar `Number()` para usar el mismo parseo que lo validó. El vacío
  sigue viajando como `null` y nunca como 0 (3.10).

**Por qué el payload puede confiar en el parseo.** `payloadDeForm` se llama en un
solo lugar (`:1912`), detrás de `disabled={!puedeGuardar}` con
`puedeGuardar = prob === null && !guardando` (`:1847`). O sea que cuando el
payload se arma, `problema()` ya devolvió `null` y ningún campo está en `error`.
El `null` de `valorONull` para el caso `error` es inalcanzable, y se deja como
`null` a propósito: si algún día ese camino se abre, el API rechaza un `null` en
un campo obligatorio de forma ruidosa, mientras que un 0 se guardaría en
silencio. Es la lección de 3.7. La Property 3 es esta invariante.

**Lo que no se agrega**, para no cambiar el veredicto de textos que hoy pasan:

- Ningún corte de decimales en las condiciones. `numeric(16,4)` redondea a cuatro
  sin avisar y hoy tampoco hay nada que lo atrape; agregar el rechazo sería una
  regresión no declarada en 2.5. Queda anotado como defecto silencioso separado.
- Ningún corte por el tope de `smallint` en `max_runs_per_day` ni por el de
  `numeric(14,2)` en los importes de reglas. Hoy los rechaza la base con un
  error de Postgres; es feo y es previo a este arreglo.

### Decisión 5 — el script de auditoría y el aviso en la UI

**El umbral vive en un módulo, no en el SQL.** `lib/ads/reglas/sospecha.ts`, puro
y sin `pg`:

```ts
export const UMBRAL_ALTO_EUR = 10;    // banda "muy probable"
export const UMBRAL_BAJO_EUR = 100;   // banda "posible"
export const METRICAS_EUR_AUDITABLES = ['spend', 'revenue', 'net', 'profit', 'budget'] as const;

export type Sospecha = {
  campo: 'action_value' | 'budget_max' | 'budget_min' | 'condicion';
  etiqueta: string;          // "techo", "gasto (condición 2)"
  valor: number;             // 1.5
  textoProbable: string;     // "1.500"
  valorProbable: number;     // 1500
  banda: 'alta' | 'baja';
};

export function sospechasDeRegla(r: ReglaAuditable): Sospecha[];
```

Si el SQL filtrara por el umbral, el `WHERE` del script y el predicado de la UI
serían dos reglas que pueden discrepar: es el mismo error que este spec está
arreglando en el parseo. El script hace un `SELECT` **amplio** y filtra en
TypeScript con el mismo predicado que la UI. Son cientos de filas: el costo es
irrelevante.

**La reconstrucción del texto es exacta**, y es lo que hace que el reporte se
pueda decidir a mano: un texto de C es `\d+\.\d{3}`, y `Number()` lo lee como ese
mismo literal decimal, así que el texto que produjo un valor guardado `v` es
`v.toFixed(3)` y el valor que se quiso es `Math.round(v * 1000)`. Corrido:
`(1.5).toFixed(3)` es `'1.500'` y `Math.round(1.5 * 1000)` es 1500;
`(10).toFixed(3)` es `'10.000'`; `(1.23).toFixed(3)` es `'1.230'`. Como
`numeric(14,2)` guarda a lo sumo dos decimales, `v * 1000` es siempre entero: no
hay ningún redondeo que adivinar.

**Los umbrales y su justificación**, que es lo que 2.12 pide documentar:

| Campo | Banda alta | Banda baja | Por qué |
|---|---|---|---|
| `budget_max`, `budget_min` | `< 10` | `10 ≤ v < 100` | Un techo de 9,99 EUR/día no puede subir casi ningún presupuesto real: es el síntoma exacto de 1.6. |
| `action_value` con `action_unit = 'fixed'` | `< 10` | `10 ≤ v < 100` | Sumar o restar menos de 10 EUR es posible, pero es también la marca de un `1.000` corrupto. |
| `action_value` con `action_unit = 'percent'` | `< 10` | — | Extensión más allá de 2.12, ver abajo. |
| Condiciones de `spend`, `revenue`, `net`, `profit`, `budget` | `< 10` | `10 ≤ v < 100` | Un umbral de gasto o de ingresos por debajo de 10 EUR es implausible en una cuenta real. |
| Condiciones de `cpa`, `cpc`, `roi`, `roas`, `ctr`, `sales`, `clicks`, `impressions` | — | — | **No auditables**: un CPA de 8 EUR, un CPC de 0,30 y un ROI de 1,3 son valores normales. Reportarlos sería ruido que entierra las sospechas reales. |
| `max_runs_per_day` | — | — | **No detectable por decisión (2.13)**: 1 ejecución diaria es legítimo y frecuente. El script lo dice en voz alta en su salida para que la omisión sea visible. |

Las dos bandas existen porque una sola no alcanza: la corrupción divide por
1000, así que una intención de cuatro dígitos (1000–9999) cae en 1–9,99 y una de
cinco (`10.000`, `25.000`) cae en 10–99,99. Con un solo corte en 10 la segunda
familia se pierde en silencio, y con un solo corte en 100 el reporte se llena de
techos chicos legítimos. Dos bandas etiquetadas dejan la decisión donde 2.13 la
pone: en una persona.

**La extensión sobre 2.12.** La cláusula nombra los importes absolutos, y
`action_unit = 'percent'` queda afuera. Se incluye igual, en un grupo aparte y
etiquetado como extensión, porque el agujero es real: para `budget_decrease` el
CHECK sólo exige `action_value < 100`, así que un `1.500` que quería decir 150%
queda guardado como 1,5 y significa «bajá el presupuesto al 1,5% del actual». Es
el peor caso de todo el bug y no cuesta nada reportarlo en un script de sólo
lectura. Si al revisar el diseño se prefiere respetar 2.12 al pie de la letra,
se saca ese grupo y no se toca nada más.

**El script.** `scripts/verificar-montos-reglas.ts`, con
`"ads:auditar-montos": "tsx scripts/verificar-montos-reglas.ts"` en
`package.json`, siguiendo la convención `ads:*` y la forma de los
`verificar-*.ts` que ya están.

- Una consulta, sólo `SELECT`, sin transacción y sin ningún `UPDATE`:
  `ad_rules LEFT JOIN ad_rule_conditions` con `id`, `account_id`, `name`,
  `action`, `action_unit`, `action_value`, `budget_max`, `budget_min`,
  `max_runs_per_day`, `metric`, `op`, `value`, `position`, ordenada por cuenta,
  regla y posición. 2.12 pide que no modifique ninguna fila, y la forma de
  garantizarlo es que no exista ninguna sentencia de escritura en el archivo.
- Salida por regla: cuenta, nombre, y una línea por sospecha con el campo, el
  valor guardado, el texto que lo habría producido, el valor probable y la banda.
  Cierra con el total por banda, la nota de `max_runs_per_day = 1` y la lista de
  métricas excluidas.
- Sale siempre con 0: es un reporte para leer, no un gate de CI. Un exit code
  distinto de cero lo convertiría en algo que alguien va a «arreglar» silenciando
  el script.

**El aviso en la UI.** En la celda «Acción y condición» de la lista, que es
donde el valor se muestra (`accionDe` en `:995`, la columna en `:1196`): un
`Badge tone="warn"`
después del texto, con el detalle de cada sospecha en el `title`. Va ahí y no al
lado del nombre porque 2.14 pide señalarlo **donde se lo ve**, y el nombre ya
tiene dos badges propios (`REAL` y «sin condiciones»). Es puramente visual: no
deshabilita nada, no filtra la lista y no impide que la regla siga corriendo
(2.14). El formulario de edición no muestra el aviso: queda fuera de alcance.

### Decisión 6 — el token de Tailwind

`ChipCascada.tsx:53`: `hover:text-good-100` → `hover:text-good-200`. El resto de
las clases del chip no se toca (3.14).

La línea es trivial; el problema es que un token que falta no rompe nada, así que
la verificación es el entregable:

1. **Comprobación puntual, a mano, para este arreglo** (es la que ya se usó en la
   auditoría):
   ```
   npx tailwindcss -c tailwind.config.ts -i app/globals.css -o /tmp/x.css
   ```
   y buscar en el CSS emitido el selector `.hover\:text-good-200:hover`, más
   confirmar que `text-good-100` no aparece en ninguna forma.
2. **Guarda permanente, en vitest** (la Property 6): un test que barre `app/`,
   `components/` y `lib/`, extrae las clases literales de la forma
   `{prefijo:}?{text|bg|border|ring|from|via|to|fill|stroke}-{escala}-{tono}` e
   importa `tailwind.config.ts` para verificar que cada tono existe en la
   paleta. Sin CLI, sin compilar CSS y sin red: corre en milisegundos con el
   resto de la suite.

   Límite declarado: sólo ve clases escritas literalmente. Una clase armada por
   interpolación (`text-${tono}-300`) es invisible para el test, igual que para
   el JIT de Tailwind, que es la razón por la que el repo las escribe completas.

### Resumen de archivos

| Archivo | Cambio |
|---|---|
| `app/(panel)/finanzas/monto.ts` → `lib/monto.ts` | Se mueve. Se extrae `leerNumeroEscrito`; `parsearMonto` queda como núcleo + política de Finanzas, con los mismos veredictos y textos |
| `app/(panel)/finanzas/monto.test.ts` → `lib/monto.test.ts` | Se mueve **sin editar** (su único import es `'./monto'`) |
| `app/(panel)/finanzas/FinanzasView.tsx` | Un import: `'./monto'` → `'@/lib/monto'` |
| `lib/ads/presupuesto.ts` | Usa el núcleo; suma el motivo `ambiguo` y el campo `texto` al rechazo; conserva el orden de cortes y `textoDeMotivo` |
| `app/(panel)/anuncios/FormularioPresupuesto.tsx` | `type="number"` + `min`/`max`/`step` → texto con `inputMode="decimal"`; el mensaje sale de `parseo.texto` |
| `app/(panel)/anuncios/GestorAnuncios.tsx` | `bloqueo: importe.texto`. `textoDeImporte` sin cambios |
| `app/(panel)/anuncios/reglas/ReglasView.tsx` | `numeroDeTexto` → `numeroDeCampo` con estado; propagación a `problemaAccion`, `problemaCondiciones`, `problemaProgramacion` y `payloadDeForm`; los dos `Number()` crudos se van; el badge de sospecha en la celda de acción |
| `app/(panel)/anuncios/ChipCascada.tsx` | `hover:text-good-100` → `hover:text-good-200` |
| `lib/ads/reglas/sospecha.ts` | **Nuevo.** Umbrales, predicado y reconstrucción del texto probable |
| `scripts/verificar-montos-reglas.ts` | **Nuevo.** Reporte de sólo lectura |
| `package.json` | **Nuevo script** `ads:auditar-montos` |

### Lo que este arreglo no cambia, y hay que saberlo

- **El backend sigue sin ser una segunda línea de defensa.** El schema
  `presupuestoEur` recibe un `number` ya parseado, y después del arreglo sigue
  recibiéndolo: cualquier cliente que postee directo al Endpoint_Acciones puede
  seguir escribiendo 1. 3.5 pide explícitamente que el endpoint acepte los mismos
  importes, así que mover la validación al servidor está fuera de alcance.
- **El mensaje de ambigüedad para textos que empiezan con 0 queda feo.**
  `0.009` produce «escribí 0009 si querés decir 0009, o 0 si querés decir 0».
  Limpiar los ceros a la izquierda cambiaría un mensaje de `parsearMonto`, y
  3.13 los congela. Queda como defecto cosmético con dueño conocido.
- **Nada corrige los datos ya guardados** (decisión 2). El script y el aviso los
  señalan; la corrección es a mano.

## Testing Strategy

### Validation Approach

Dos fases. Primero se escriben tests que **fallan sobre el código sin arreglar**,
para confirmar que la causa raíz es la que se hipotetizó y no otra. Después se
verifica que el arreglo cumple P para todo texto de C, y que no movió el
veredicto de nada más.

La preservación necesita poder llamar a la implementación vieja, que después del
arreglo ya no existe. Se **congela como oráculo dentro del test**, duplicada a
propósito. No es una idea nueva en este repo: `lib/ads/presupuesto.test.ts` ya lo
hace con la `reglaOriginal` copiada del `valido` de `FormularioPresupuesto`, con
el comentario «es el oráculo de la refactorización». Acá se congelan dos: el
`parsearPresupuesto` de hoy (seis líneas) y el `numeroDeTexto` de hoy (dos).
`parsearMonto` no necesita oráculo: sus 12 tests, que se mueven sin editarse, ya
son exactamente eso.

### Exploratory Bug Condition Checking

**Objetivo**: hacer aparecer los contraejemplos sobre el código sin arreglar y
confirmar o refutar la hipótesis. Si se refuta, se re-hipotetiza antes de tocar
nada.

**Plan**: llamar a los cuatro parseos con los textos de C y mirar qué devuelven,
sin mocks y sin render. Los tres primeros son funciones puras exportadas; el
cuarto (`Number()` crudo) se ejercita a través de `problemaProgramacion` y
`payloadDeForm`, que también son puras.

**Casos**:

1. `parsearPresupuesto('1.000', 5000)` → se espera `{ok:true,valor:1}`
   (fallará contra el comportamiento correcto).
2. `numeroDeTexto('1.000')` → se espera 1, y `problemaAccion` con
   `actionValue: '1.000'` → se espera `null`, o sea «no hay nada que reportar»
   sobre un valor mil veces menor. Es el contraejemplo de 1.8 y 2.9.
3. `problemaCondiciones` con una condición `spend > '1.000'` → se espera `null`,
   y `payloadDeForm` → se espera `value: 1`.
4. `problemaProgramacion` con `maxRunsPerDay: '1.000'` → se espera `null`, y el
   payload → `1`.
5. Borde de la regla ancha: `parsearPresupuesto('1000.000', 5000)` → se espera
   `{ok:true,valor:1000}`. Confirma que la familia (e) existe y que hoy se
   acepta.
6. `parsearPresupuesto('100,50', 5000)` → se espera `no_numero`, contra
   `parsearMonto('100,50')` → 100,5. Es la incoherencia de 1.4 medida en un solo
   test.

**Contraejemplos esperados**: los cuatro sitios devuelven un número mil veces
menor sin ningún rechazo. Si alguno **no** lo hiciera, la hipótesis está mal y
hay que volver a §Hypothesized Root Cause antes de escribir el arreglo.

### Fix Checking

**Objetivo**: para todo texto de C, el resultado cumple P.

**Pseudocódigo:**
```
FOR ALL texto WHERE isBugCondition(texto) DO
  ASSERT parsearPresupuesto(texto, techo).ok = false
  ASSERT rechazo.texto CONTAINS textoSinPunto(texto)
  ASSERT rechazo.texto CONTAINS textoTruncadoEnElPunto(texto)

  ASSERT numeroDeCampo(texto).estado = 'error'
  ASSERT numeroDeCampo(texto).motivo = 'ambiguo'

  FOR EACH campo IN {actionValue, budgetMax, budgetMin, condicion, maxRunsPerDay} DO
    f := formConCampo(campo, texto)
    ASSERT problema(f) <> null
    ASSERT problema(f) CONTAINS nombreDe(campo)
  END FOR
END FOR
```

El generador de C es directo y cubre la familia entera:
`fc.tuple(fc.integer({min:0,max:999}), fc.integer({min:0,max:999}))` formateado
como `${izq}.${padStart(der, 3, '0')}`, más la familia (e) con 4 a 8 dígitos a la
izquierda.

### Preservation Checking

**Objetivo**: para todo texto fuera de C, el resultado es el mismo que hoy, salvo
las siete familias declaradas.

**Pseudocódigo:**
```
FOR ALL texto, techo WHERE NOT isBugCondition(texto) DO
  IF parsearPresupuestoOriginal(texto, techo) <> parsearPresupuesto(texto, techo) THEN
    ASSERT esExcepcionDeclarada(texto)   // familias a–g, cada una con su cláusula
  END IF
END FOR
```

**Enfoque**: property-based, por dos razones concretas. La primera es que el
dominio interesante son cadenas y el espacio es infinito: una tabla de casos
sólo prueba los casos que a alguien se le ocurrieron, y el bug original vivía
justamente en el caso que a nadie se le ocurrió. La segunda es que la propiedad
está escrita al revés que una tabla: no dice «este texto da esto», dice **«si
algo cambió, tiene que estar declarado»**, así que cualquier cambio de veredicto
que el arreglo introduzca sin querer aparece como contraejemplo con el texto
exacto que lo dispara.

`esExcepcionDeclarada` se escribe como código, familia por familia, con el número
de cláusula al lado. Es el punto débil de la propiedad: un predicado demasiado
ancho la vuelve trivialmente verdadera. Por eso van dos guardas más:

- El predicado se escribe como siete regex nombradas, una por familia, no como
  una condición compuesta que se pueda ensanchar de a poco.
- Un test de tabla aparte prueba, para cada familia, que el flip **ocurre**:
  afirma el veredicto viejo con el oráculo y el nuevo con el arreglo. Si alguien
  ensancha el predicado para tapar un flip nuevo, esa tabla no lo cubre y la
  propiedad de C tampoco.

**Casos** (además de la propiedad):

1. Los 12 tests de Finanzas, corriendo desde `lib/monto.test.ts`, **sin una sola
   línea editada**. Es la verificación literal de 3.13.
2. Los casos pinneados de `lib/ads/presupuesto.test.ts` que no cambian: vacío y
   espacios → `vacio`; `abc`, `NaN`, `Infinity`, `-Infinity`, `1.2.3` →
   `no_numero`; `0`, `-0`, `-5` → `bajo_el_minimo`; `0.01` y el techo exacto →
   válidos; `100.01` y `1000` → `sobre_el_techo`; techo `NaN` o 0 → todo
   `sobre_el_techo`.
3. Reglas: `1,5` sigue siendo 1,5 (3.8); la condición vacía sigue dando su
   mensaje textual (3.7); `ventas <= 0` sigue guardándose (3.9); los cuatro
   campos vacíos siguen viajando como `null` (3.10); techo menor al piso sigue
   reportándose (3.12).
4. `presupuestoDialogo.test.ts`: las dos propiedades y los casos de ida y vuelta
   siguen pasando sin cambios.

**Los cinco casos existentes que sí cambian**, uno por uno. Se declaran acá para
que la tarea de implementación no los descubra como sorpresas y los «arregle»
aflojando una aserción:

| Test | Caso | Hoy | Con el arreglo | Por qué |
|---|---|---|---|---|
| `presupuesto.test.ts` | `motivoDe('1,5')` | `no_numero` | válido, 1,5 | 2.2 |
| `presupuesto.test.ts` | `motivoDe('0.009')`, `motivoDe('0.005')`, `motivoDe('100.001')` | `bajo_el_minimo` / `sobre_el_techo` | `ambiguo` | están dentro de C: un punto y tres dígitos a la derecha |
| `presupuesto.test.ts` | `motivoDe('10.005')`, `('12.345')`, `('0.011')` | `mas_de_dos_decimales` | `ambiguo` | están dentro de C. El caso de tres decimales se reescribe con coma (`'10,005'`), donde sigue siendo `mas_de_dos_decimales` |
| `presupuesto.test.ts` | `valorDe('1e2')`, `motivoDe('1e-3')`, `motivoDe('1e21')` | 100 / `bajo_el_minimo` / `sobre_el_techo` | `no_numero` | 2.5. El test de notación exponencial pasa de «se interpreta» a «se rechaza» |
| `presupuestoDialogo.test.ts` | `presupuestoDelDialogo('10.005').bloqueo` contiene `'decimales'` | `mas_de_dos_decimales` | `ambiguo` | está dentro de C. Se reescribe con `'10,005'` |

Ninguno de los cinco toca los 12 tests de Finanzas.

### Unit Tests

- **Núcleo (`leerNumeroEscrito`)**: los cuatro motivos; la coma decimal y el
  punto decimal; las dos agrupaciones de miles (`1.000.000` y `1,000,000`); las
  dos mixtas (`1.234,56` y `1,234.56`); la agrupación mal formada (`1.00.000`);
  `.5`, `5.` y `.` solo, que resuelve como 0; los negativos, que vuelven como
  valor negativo y no como error; la cantidad de decimales reportada; el ruido
  (`€`, espacio fino, duro y BOM).
- **`parsearMonto`**: los 12 tests que ya existen, sin cambios.
- **`parsearPresupuesto`**: el orden de los cortes, con el motivo pinneado caso
  por caso como ya está, más las cuatro entradas nuevas del mapeo (`ambiguo`; el
  negativo que sigue siendo `bajo_el_minimo`; `€` solo, que es `no_numero` y no
  `vacio`; y `'.'`, que pasa a `bajo_el_minimo` y queda pinneado para que el
  cambio de mensaje sea deliberado y no un descubrimiento).
- **`textoDeMotivo`**: los seis motivos tienen mensaje no vacío, y el `Record`
  sigue siendo completo.
- **`numeroDeCampo`**: los tres estados, con `'   '` como `vacio` y no como
  error, y `'1.000'` como `error` con motivo `ambiguo`.
- **Las tres funciones `problema*`**: un caso por rama nueva, verificando que el
  mensaje nombra el campo y, cuando es ambiguo, que contiene las dos lecturas.
- **`sospechasDeRegla`**: las dos bandas y sus bordes exactos (9,99 / 10 / 99,99
  / 100); las métricas excluidas devuelven lista vacía; `max_runs_per_day` nunca
  produce sospecha; la reconstrucción `1.5 → "1.500" → 1500` y `10 → "10.000" →
  10000`.

### Property-Based Tests

Con `fast-check` 4.9.0, que ya está en `devDependencies` y ya se usa en 25
archivos del repo. Los generadores de texto de campo se reusan de
`lib/ads/presupuesto.test.ts`, que ya incluye `0x10`, `0b11`, `0o17`, `+5`,
`.5`, `5.`, los espacios unicode y el BOM.

- **Property 1**: para todo texto de C (generado como `${1..999}.${000..999}`) y
  para los cinco campos, hay rechazo, el mensaje trae las dos lecturas y no hay
  valor en ningún payload.
- **Property 2**: la preservación contra el oráculo congelado, con el predicado
  de excepciones. `numRuns` alto (≥ 1000): es el test que protege de verdad, y
  es barato.
- **Property 3**: para todo `FormEstado` generado, si `problema(f)` es `null`
  entonces cada número del payload coincide con el parseo de su texto, y cada
  campo vacío es `null`. Se genera sobre el `formBase` que ya existe en
  `_nombres.test.ts`.
- **Property 4**: para todo texto, `leerNumeroEscrito` es el que decide en las
  tres pantallas: si dos de ellas aceptan el mismo texto, el número es el mismo.
- **Property 5**: para todo texto rechazado, `parseo.texto` no es vacío y es
  exactamente lo que el campo y el diálogo muestran.
- **Property 6**: el barrido de clases de color literales contra la paleta.
- **Property 7**: para toda regla generada, `sospechasDeRegla` es determinista y
  la reconstrucción cumple `Number(textoProbable) === valor` y
  `valorProbable === Math.round(valor * 1000)`.

### Integration Tests

Sin base y sin red, como el resto del módulo: las funciones son puras y el
recorrido completo se puede armar componiéndolas.

- **Presupuesto, punta a punta**: texto → `presupuestoDelDialogo` → payload →
  el schema `presupuestoEur` del Endpoint_Acciones → `aplicarPresupuesto`. Para
  `1.000` no hay payload; para `1000` llega `daily_budget: '100000'`. Es el
  recorrido de la introducción del bugfix, medido de una punta a la otra.
- **Reglas, punta a punta**: `FormEstado` con `1.000` en cada uno de los cinco
  campos → `problema` bloquea y `payloadDeForm` no se llama; con `1000` →
  payload correcto y el schema del API lo acepta.
- **Auditoría**: `sospechasDeRegla` sobre un conjunto de reglas armado a mano que
  incluya un valor de cada banda, un valor legítimo chico (un techo de 5 EUR
  puesto a propósito, que se reporta como sospecha y así queda declarado como
  falso positivo esperado), una condición de CPA baja (que no se reporta) y un
  `max_runs_per_day = 1` (que no se reporta).
- **Round-trip de la celda**: `textoDeImporte(eur)` → campo → parseo → el mismo
  importe, para todo `eur` de dos decimales. Ya existe como propiedad y sigue
  pasando: es la verificación de que sacar `type="number"` no rompió la siembra.
- **El CSS compilado**, una vez y a mano: el selector `.hover\:text-good-200:hover`
  aparece y `text-good-100` no aparece en ninguna forma.
