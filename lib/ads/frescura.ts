/**
 * La Frescura_Objeto y sus números, en UN solo lugar.
 *
 * Nace de un default copiado cuatro veces: el 900 del umbral estaba escrito como
 * literal suelto en `lib/ads/acciones.ts` (`topesDeSettings`), en
 * `app/api/data/ads/route.ts`, en `app/(panel)/anuncios/page.tsx` y en
 * `app/(panel)/anuncios/GestorAnuncios.tsx`. Cuatro lugares que tienen que decir
 * lo mismo y ningún lugar que lo diga una vez: es el mismo problema que
 * `lib/ads/zona.ts` vino a resolver con `TZ_DEFAULT`.
 *
 * **Este módulo es puro y no importa NADA.** Lo leen un módulo de servidor
 * (`lib/ads/acciones.ts`), dos endpoints y dos archivos de cliente
 * (`page.tsx` y `GestorAnuncios.tsx`, este último `'use client'`). Si alguna vez
 * importa `pg`, `next/headers` o `lib/db`, el bundle del cliente se rompe.
 */

/**
 * Segundos a partir de los cuales la Frescura_Objeto de una fila se considera
 * vieja, cuando `settings.ads_frescura_umbral_segundos` no trae un número.
 *
 * **Repite el seed de `db/migrations/025_ads_frescura.sql`**
 * (`('ads_frescura_umbral_segundos', '900'::jsonb)`), y esa repetición es la
 * quinta copia de este valor: el SQL de una migración no puede importar un
 * módulo de TypeScript. **Queda declarada, no olvidada.** Lo que compra este
 * módulo es que la próxima vez que el default cambie haya que tocar DOS lugares
 * —esta constante y el seed— en lugar de cinco.
 *
 * El default importa porque `settings.value` es jsonb y puede tener cualquier
 * cosa: un `NaN` acá dejaría a todos los objetos por encima del umbral y
 * convertiría cada click en una relectura contra Meta.
 */
export const UMBRAL_FRESCURA_DEFAULT_SEGUNDOS = 900;
/**
 * Cada cuántos segundos corre el sync de la jerarquía de anuncios.
 *
 * **Es un ESPEJO de `deploy/cron.panel`, no la fuente**, y que sea espejo es
 * inevitable: la fuente es el crontab del host, un archivo que se instala con
 * `crontab -e` y que el proceso no lee nunca en runtime. Parsear sintaxis de cron
 * para derivar un umbral es más máquina de la que el problema pide.
 *
 * Lo que impide que el espejo se desincronice en silencio es
 * `lib/ads/frescura.cron.test.ts`: lee el archivo del repo, busca la línea de
 * `scripts/sync-ads-jerarquia.ts`, traduce su schedule a segundos y lo compara con
 * esta constante. Cambiar el período del cron sin tocar este número rompe la
 * suite, que es lo que R1.4 pedía y no existía.
 *
 * Lo que ese test NO puede verificar es que el crontab instalado en el host sea el
 * archivo del repo. El propio `deploy/cron.panel` ya advierte ese hueco, con el
 * `diff` contra `crontab -l` que hay que correr a mano.
 */
// El schedule textual va en comentario de línea y no en el bloque de arriba: la
// barra de un `*/15` cerraría el comentario. La línea de la jerarquía de
// `deploy/cron.panel` empieza con `*/15 * * * *`, o sea cada 15 min = 900 s.
export const PERIODO_SYNC_JERARQUIA_SEGUNDOS = 900;

/**
 * Margen que se le SUMA al umbral de frescura para decidir si el preflight de una
 * acción tiene que ir a Meta a releer un objeto.
 *
 * ## Qué estaba mal sin él
 *
 * `synced_at` se escribe al inicio de la transacción de `escribirCuenta`, que
 * corre DESPUÉS de todas las lecturas a Meta: la marca queda al final de las
 * lecturas de la corrida, no al arranque. Con el umbral igual al período del cron
 * —900 y 900— la edad de una fila sana recorre `[0, período + duración]`, así que
 * toda la varianza de la corrida y todo el jitter del cron caen del lado de
 * «viejo» y meten una lectura a Meta en el camino crítico de un click. La
 * relectura existe para el caso en que el sync FALLÓ, no para el caso en que
 * anduvo bien.
 *
 * ## Las dos cotas, que son lo que hace elegible al número
 *
 * - **Cota inferior**: tiene que absorber la duración de la corrida más el jitter
 *   del cron. Con un margen más corto que una corrida el síntoma vuelve a ser el
 *   de hoy.
 * - **Cota superior**: tiene que ser ESTRICTAMENTE MENOR que el período. Un objeto
 *   que se perdió una corrida tiene edad ≈ 2 × período, y
 *   `2 × período > período + margen ⟺ margen < período`: con `margen >= período`
 *   ese objeto dejaría de disparar la relectura, que es exactamente lo que la
 *   relectura vino a cubrir.
 *
 * La mitad del período está estrictamente dentro de las dos. Es proporcional y no
 * fijo por el mismo motivo que `pisoDeFrescura` de `lib/ads/live.ts`: un margen
 * fijo no sirve para todo período —10 s no absorben una corrida de un cron de 15
 * min, y 450 s violarían la cota superior en un cron de 60 s—.
 *
 * Con el período real el margen es **450 s** y el umbral de relectura queda en
 * **1350 s**.
 *
 * ## EL SIGNO, que es la única parte del precedente que NO se copia
 *
 * `pisoDeFrescura(ttl) = max(0, ttl − min(10, ttl / 4))` **RESTA** su margen, y
 * allá está bien: la comparación de `live.ts` es `edad < piso ⇒ está fresco, no
 * sincronices`, así que BAJAR el piso ADELANTA el sync. Acá la comparación es la
 * inversa —`edad > umbral ⇒ está viejo, releé`— y lo que se busca es que la
 * relectura se dispare DESPUÉS. **Con el margen restado el umbral de relectura
 * quedaría en 675 s y la relectura se dispararía en MÁS clicks que hoy, no en
 * menos.** Mismo razonamiento, signo opuesto: por eso el margen se SUMA.
 *
 * ## Fraccionario a propósito: NO se redondea
 *
 * Con un período impar el margen tiene medio segundo, y queda así. No es pereza:
 * la edad contra la que se compara sale de un `Math.floor` (`edadEnSegundos` de
 * `lib/ads/acciones.ts`), o sea que es un entero de segundos, y para enteros
 * `edad > 1350.5` decide exactamente igual que `edad > 1350`. Redondear agregaría
 * un paso que no cambia ni una decisión. Fijado por test en `frescura.test.ts`.
 */
export function margenDeRelectura(periodoSegundos: number): number {
  return periodoSegundos / 2;
}

/**
 * Los segundos a partir de los cuales el preflight de una acción decide que el
 * dato local no alcanza y hay que releer el objeto contra Meta: la SUMA del umbral
 * de frescura configurado y el margen del período del cron.
 *
 * **No es el mismo número que la Marca_Frescura de la tabla, y eso es a
 * propósito**: son dos preguntas distintas sobre el mismo valor de `settings`.
 * `frescuraDeFila` (`app/(panel)/anuncios/celdas.tsx`) pregunta «¿este dato se le
 * tiene que ver viejo a una persona?» y NO lleva margen: metérselo movería el
 * borde de la marca visual de 900 a 1350 s —un cambio de producto que nadie pidió—
 * y rompería la semántica documentada de su `>`, que es «una fila con exactamente
 * `umbralSegundos` de antigüedad todavía está al día». El único consumidor de esta
 * función es `causaDeRelectura`.
 *
 * ## Límite declarado: con el umbral por DEBAJO del período, el margen no rescata
 *
 * Con `ads_frescura_umbral_segundos = 60` el umbral de relectura queda en 510 s,
 * que sigue siendo menor que el período, y la relectura se sigue disparando en la
 * mayoría de los clicks. **Se evaluó `max(umbralSegundos, periodoSegundos) + margen`
 * para taparlo y SE DESCARTÓ**: haría que el preflight ignore en silencio un valor
 * que un operador puso a propósito. Queda como límite escrito y no como defensa
 * silenciosa; tampoco hay evidencia de que nadie lo haya bajado.
 */
export function umbralDeRelectura(umbralSegundos: number, periodoSegundos: number): number {
  return umbralSegundos + margenDeRelectura(periodoSegundos);
}
