/**
 * El Refresco_Diferido del POST de acciones: disparar un trabajo best-effort y
 * NO esperarlo (tanda C de `toggle-conjuntos-entrega`, task 14.2).
 *
 * Lo usa `route.ts` para `refrescarJerarquia`, que es una lectura del objeto
 * contra Meta con su propio `AbortSignal.timeout(30_000)` cuyo resultado no
 * necesita nadie para responder: la respuesta ya sabe que Meta confirmó.
 *
 * ## POR QUÉ EL FIRE-AND-FORGET ES LEGÍTIMO ACÁ Y NO LO SERÍA EN UNA LAMBDA
 *
 * Dos hechos, los dos del entorno de este panel y no de la teoría:
 *
 * 1. `refrescarJerarquia` **ya no rechaza nunca**: su `catch {}` se come todo, así
 *    que un trabajo diferido no puede dejar un rejection sin manejar. El
 *    `then(quitar, quitar)` de abajo lo cubre igual, por si algún día cambia.
 * 2. El panel corre en un proceso Node de vida larga bajo PM2, **no** en una
 *    función serverless que se apaga cuando la respuesta sale. El trabajo
 *    diferido efectivamente corre. En una lambda esto sería una llamada que se
 *    pierde a mitad de camino, y ahí el diferimiento no valdría.
 *
 * ## POR QUÉ EL REGISTRO EXISTE
 *
 * Sin él, `route.frescura.test.ts` —que verifica que una escritura confirmada
 * adelanta `synced_at` y limpia `desaparecido_at`— pasaría a depender del timing
 * y se volvería flaky, que es la forma más cara de romper una suite. Con el
 * registro, el test hace `await esperarRefrescosPendientes()` y la espera es
 * exacta: no hay ningún `setTimeout` de gracia que la máquina lenta del día
 * pueda invalidar.
 *
 * ## POR QUÉ ESTE MÓDULO EXISTE Y NO ES UN PAR DE FUNCIONES EN `route.ts`
 *
 * Porque un `route.ts` **no puede exportar nada que no sea un método HTTP o una
 * opción de segmento**. El validador de tipos que `next build` genera en
 * `.next/types/app/api/ads/acciones/route.ts` exige que todo export que no esté
 * en su lista sea `never`, y `tsconfig.json` incluye `.next/types/**`, así que el
 * error aparece también en `npx tsc --noEmit`:
 *
 *     error TS2344: Type 'OmitWithTag<typeof import(".../route"), …>' does not
 *     satisfy the constraint '{ [x: string]: never; }'.
 *       Property 'esperarRefrescosPendientes' is incompatible with index signature.
 *         Type '() => Promise<void>' is not assignable to type 'never'.
 *
 * El diseño ponía el helper adentro de `route.ts`; se corrió el experimento, dio
 * ese error, y el helper salió a un módulo hermano. Es la misma razón por la que
 * `_server.ts` y `_tipos.ts` viven al lado de la página de reglas.
 */

/**
 * Los refrescos que arrancaron y todavía no terminaron.
 *
 * A nivel de módulo y no por request: el registro tiene que sobrevivir a la
 * respuesta, que es justamente lo que el diferimiento hace. Un `Set` y no un
 * contador para que `esperarRefrescosPendientes` pueda esperar a las promesas
 * concretas en lugar de hacer polling sobre un número.
 */
const pendientes = new Set<Promise<unknown>>();

/**
 * Dispara el trabajo y devuelve enseguida. El llamador NO lo espera: eso es todo
 * el cambio de la tanda C.
 */
export function diferir(trabajo: Promise<unknown>): void {
  pendientes.add(trabajo);
  const quitar = (): void => {
    pendientes.delete(trabajo);
  };
  // `then(quitar, quitar)` y no `finally(quitar)`: `finally` devuelve una promesa
  // que hereda el rechazo, y nadie la mira. Con los dos handlers, un trabajo que
  // rechace queda manejado acá y no cae en `unhandledRejection`.
  trabajo.then(quitar, quitar);
}

/**
 * Espera a que no quede ningún refresco en vuelo. **Es para los tests**: el
 * request no la llama nunca, porque esperar sería volver a poner la relectura en
 * el camino crítico.
 *
 * El `while` cubre el trabajo diferido que difiere más trabajo: hoy no pasa
 * —`refrescarJerarquia` es una lectura y un `UPDATE`— pero si algún día pasa, la
 * espera sigue siendo completa en lugar de quedarse corta por una vuelta.
 *
 * `allSettled` y no `all`: un trabajo que rechace no puede hacer fallar la
 * espera, porque el trabajo es best-effort por definición.
 */
export async function esperarRefrescosPendientes(): Promise<void> {
  while (pendientes.size > 0) {
    await Promise.allSettled([...pendientes]);
  }
}
