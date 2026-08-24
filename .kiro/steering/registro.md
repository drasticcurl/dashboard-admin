# Registrar cada cambio en registro.md

Todo cambio de código en este proyecto se anota en `registro.md` (raíz), en la
misma tanda de trabajo que el cambio. No al final de la semana, no "después":
el motivo se olvida en horas y es lo único que este archivo aporta.

## Por qué existe esta regla

El 2026-08-24 el working tree tenía tres cosas mezcladas y sin commitear: un
rediseño de UI hacia adelante, un revert de cuatro features ya commiteadas de
`/anuncios/reglas`, y dos scripts temporales. Nada indicaba cuál era
intencional.

Separarlo costó leer diffs de 1500 líneas y comparar contra `git log` para
recién ahí darse cuenta de que el "cambio" de Reglas borraba la validación que
evita que una condición vacía se guarde como `> 0` — que en una regla de pausar
significa *pausá todo*. Si hubiera estado registrado, la pregunta "¿esto se sacó
a propósito?" se contestaba leyendo una entrada.

`git log` contesta **qué** cambió. Esto contesta **por qué**, y sobre todo qué
se descartó y qué se rompe si alguien lo vuelve atrás.

## Cómo se escribe una entrada

Lo más nuevo arriba. Una sección por tanda de trabajo, con la fecha y el hash
del commit cuando exista.

Cada entrada responde tres preguntas, en este orden:

1. **Qué pasaba.** El síntoma concreto, como lo vio quien lo reportó o como se
   reprodujo. No "había un bug en el parseo": `Number("100,50")` daba `NaN` y el
   botón quedaba gris sin decir por qué.
2. **Por qué se resolvió así.** Las alternativas que se descartaron y el motivo.
   Esto es lo que le sirve al que venga: sin el descarte, va a proponer de nuevo
   la opción que ya falló.
3. **Qué se verificó.** Qué se corrió y qué quedó sin verificar. "Pasa el build"
   no es evidencia de que algo funcione.

Reglas de forma:

- **Escribí el motivo, no el diff.** Si la entrada se puede generar leyendo
  `git diff`, no aporta nada.
- **Los números y los mensajes de error, textuales.** `22P02 invalid input
  syntax for numeric: "undefined"` sirve; "daba un error de Postgres" no.
- **Registrá lo que decidiste NO hacer.** Un cambio que se descartó a propósito
  vale tanto como uno que entró, y es lo que evita que alguien lo "arregle" de
  nuevo. La sección del 2026-08-24 sobre Reglas es el ejemplo.
- **Si un cambio deja una consecuencia pendiente, decilo ahí mismo** (un token
  que todavía no existe, un archivo que quedó sin llamadores, una migración que
  falta correr).
- Castellano, como el resto de la documentación del proyecto.

## Cuándo NO hace falta

- Renombres mecánicos y formateo que no cambian comportamiento.
- Cambios que sólo tocan `registro.md`.

Si dudás, registralo: una entrada de más cuesta dos minutos, una de menos costó
la sesión entera del 2026-08-24.

## Lo que esta regla no reemplaza

- El mensaje de commit sigue explicando el cambio en detalle. `registro.md` es
  la vista cronológica y la que se lee sin `git`.
- `COMO-DEPLOYAR.md` §"Cosas que ya pasaron y no conviene repetir" sigue siendo
  el lugar de los incidentes de **deploy e infraestructura**. Si un cambio causó
  una caída, va en los dos.
- Las decisiones de arquitectura de una feature siguen viviendo en su plan
  (`tasks/`) y en los comentarios del código, que es donde se leen en contexto.
