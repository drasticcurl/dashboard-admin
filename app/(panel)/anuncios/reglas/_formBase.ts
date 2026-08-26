/**
 * El `FormEstado` de prueba del formulario de Reglas: válido en todo, para que el
 * único motivo de bloqueo posible sea el campo que cada test pone bajo prueba.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO. La misma función estaba copiada en tres tests
 * (`_nombres.test.ts`, `../montoAmbiguo.test.ts` y `numeroDeCampo.test.ts`), y la
 * task 4.1 iba a ser la cuarta copia. Tres copias de un fixture de veinte campos
 * son tres fixtures que se desincronizan de a uno: el día que `FormEstado` suma
 * un campo, el test que no se actualizó pasa a probar otro formulario que el
 * resto. Es el mismo argumento por el que este spec existe —una regla escrita
 * cuatro veces— una escala más abajo, así que se extrajo acá en lugar de sumar
 * una copia más.
 *
 * VIVE AL LADO DE `ReglasView.tsx` Y NO EN `lib/test/` a propósito: `FormEstado`
 * es un tipo de ESTA pantalla, no del dominio, y desde acá el import es
 * `./ReglasView` en lugar de un especificador con el grupo de rutas adentro
 * (`@/app/(panel)/anuncios/reglas/ReglasView`), que es la forma que el diseño ya
 * descartó para el módulo de monto. El prefijo `_` es la convención de la carpeta
 * para lo que no es una ruta (`_nombres.ts`, `_server.ts`, `_tipos.ts`).
 *
 * SÓLO LO IMPORTAN TESTS, así que no entra al bundle. El import de `problema` es
 * `import type`: no hay ninguna dependencia en runtime, sólo la lectura del tipo.
 */

import type { problema } from './ReglasView';

/**
 * El estado del formulario, tomado del único lugar donde está declarado en lugar
 * de volver a escribirlo: si `problema` cambia de firma, esto no compila.
 */
export type FormEstado = Parameters<typeof problema>[0];

/**
 * Un formulario que guarda sin problemas, con lo que el test necesite pisado.
 *
 * `action: 'pause'` y las dos listas vacías no son casualidad: con una acción de
 * presupuesto, `problemaAccion` pide valor y techo, y cualquier test que quiera
 * medir OTRO campo se bloquearía por esos dos y creería estar midiendo lo suyo.
 */
export function formBase(over: Partial<FormEstado> = {}): FormEstado {
  return {
    name: 'Regla de prueba',
    accountId: 'act_123',
    level: 'adset',
    statusFilter: 'active',
    nameFilter: '',
    nameFilterMode: 'contains',
    action: 'pause',
    actionValue: '',
    actionUnit: 'percent',
    budgetMax: '',
    budgetMin: '',
    period: 'today',
    everyMinutes: 15,
    windowStart: '',
    windowEnd: '',
    maxRunsPerDay: '',
    cooldownMinutes: 60,
    maxActionsPerObjectPerDay: 4,
    conditions: [],
    ...over,
  };
}
