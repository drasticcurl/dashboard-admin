import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Condicion } from '@/lib/ads/tipos';
import { numeroDeCampo, payloadDeForm, problema } from './ReglasView';
import { formBase, type FormEstado } from './_formBase';
import { textoDeC, textoDeCampo } from '@/lib/test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — Property 3: Payload fiel
 *
 * **Validates: Requirements 2.6, 2.8, 3.9, 3.10**
 *
 * NINGÚN PAYLOAD LLEVA UN NÚMERO QUE EL TEXTO NO DICE. Para todo `FormEstado`, si
 * `problema(f)` devuelve `null` entonces cada número de `payloadDeForm(f)` es el
 * que su texto dice, y cada campo en blanco viaja como `null` y NUNCA como 0.
 *
 * ─── POR QUÉ ESTA INVARIANTE ES LA QUE IMPORTA ──────────────────────────────
 *
 * `payloadDeForm` se llama en UN SOLO lugar de producción: el `onClick` del botón
 * Guardar de `ReglasView.tsx`, detrás de su `disabled={!puedeGuardar}` con
 * `puedeGuardar = prob === null && !guardando`. O sea: el payload sólo existe
 * cuando `problema` dijo que no hay problema. Eso convierte «la validación mira el
 * texto» y «el payload arma el número» en una sola afirmación verificable —la de
 * este archivo— en lugar de dos funciones que hay que acordarse de mantener de
 * acuerdo. (Sin número de línea a propósito: los comentarios del propio
 * `ReglasView.tsx` todavía citan `:1912` y `:1847`, que la task 3.5 corrió unas
 * doscientas líneas más abajo.)
 *
 * Es exactamente lo que faltaba cuando el bug entró: `problemaAccion` aprobaba
 * `'1.000'` porque preguntaba `Number.isFinite` sobre el número ya corrompido, y
 * `payloadDeForm` volvía a hacer el mismo `Number()` por su cuenta. Las dos
 * coincidían, y las dos estaban mal (cláusula 1.8).
 *
 * ─── LOS DOS ORÁCULOS, Y POR QUÉ HAY DOS ────────────────────────────────────
 *
 * 1. **El parseo** (`numeroDeCampo`): el payload tiene que llevar el número que el
 *    MISMO parseo que validó el texto leyó de él. Sirve para todo texto, pero es
 *    de a poco circular: si el parseo entero se equivocara igual en los dos lados,
 *    la aserción pasaría.
 * 2. **Un oráculo independiente**, para los textos donde el número que dice se
 *    puede afirmar sin llamar a ninguna función del arreglo: sólo dígitos
 *    (`'1000'` es mil) y dígitos con coma decimal (`'10,50'` es diez cincuenta).
 *    Es el que agarra el bug original de frente: con el `Number('1.000')` de antes,
 *    un payload de 1 pasaba el oráculo 1 y moría en este.
 *
 * ─── QUÉ NO CUBRE ───────────────────────────────────────────────────────────
 *
 *   · que un texto ambiguo bloquee el guardado → `../montoAmbiguo.test.ts`
 *     (Property 1), que lo mide campo por campo con el mensaje;
 *   · el mensaje de cada rama de las tres `problema*` → `numeroDeCampo.test.ts`;
 *   · `everyMinutes`, `cooldownMinutes` y `maxActionsPerObjectPerDay`: son `number`
 *     en el estado del formulario (salen de un select y de dos steppers), nunca se
 *     parsean de un texto, así que no hay ningún «número que el texto no dice» que
 *     puedan llevar.
 *
 * Todo es puro: no hay base, ni red, ni render.
 */

// ─── Generadores ─────────────────────────────────────────────────────────────

const METRICAS: readonly Condicion['metric'][] = [
  'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
  'budget', 'impressions', 'clicks', 'ctr', 'cpc',
];
const OPS: readonly Condicion['op'][] = ['>', '>=', '<', '<=', '=', '!='];

/**
 * Los textos donde el número que dicen se puede afirmar SIN el arreglo: dígitos
 * solos, dígitos con punto decimal y dígitos con coma decimal. Son la materia
 * prima del oráculo independiente y, de paso, lo que hace que una parte
 * apreciable de los formularios generados llegue a habilitar Guardar.
 */
const numeroBienEscrito: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 5_000 }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 500_000 }).map((c) => String(c / 100)) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: 100, max: 30_000 })
      .map((c) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`),
  },
);

/**
 * Lo que puede haber en un campo numérico del formulario. La mezcla está pesada
 * hacia números bien escritos A PROPÓSITO: con puro texto al azar casi todos los
 * formularios quedarían bloqueados y la propiedad se cumpliría de forma trivial,
 * sin haber armado nunca un payload. El contador de abajo lo verifica en lugar de
 * confiar en la intuición.
 *
 * `textoDeCampo` es el generador compartido de `lib/test/preservacion-montos.ts`
 * (el mismo de las dos preservaciones): trae el ruido, los espacios unicode, la
 * notación exponencial, `0x10` y compañía. `textoDeC` trae la Bug_Condition, que
 * acá aparece del lado que importa: el formulario que NO se puede guardar.
 */
const textoNumerico: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: numeroBienEscrito },
  { weight: 2, arbitrary: textoDeCampo },
  { weight: 1, arbitrary: fc.constantFrom('', ' ', '   ') },
  { weight: 1, arbitrary: textoDeC },
);

/**
 * Un `FormEstado` completo sobre el fixture compartido. Sólo varían los cinco
 * campos numéricos, la acción y la unidad: el nombre, la cuenta y la ventana
 * horaria quedan válidos para que el único motivo de bloqueo posible sea un
 * número, que es lo que esta propiedad mide.
 *
 * `fixed` va con más peso que `percent` porque con `percent` los avisos de
 * «un factor menor a 100 BAJA el presupuesto» bloquean casi todo, y `budgetMin`
 * sale `'1'` seguido: un piso más alto que el techo también bloquea, y el
 * formulario bloqueado no arma payload y no prueba nada.
 */
const genForm: fc.Arbitrary<FormEstado> = fc
  .record({
    action: fc.constantFrom(
      'pause' as const,
      'activate' as const,
      'budget_increase' as const,
      'budget_decrease' as const,
    ),
    actionUnit: fc.constantFrom('fixed' as const, 'fixed' as const, 'percent' as const),
    actionValue: textoNumerico,
    budgetMax: textoNumerico,
    budgetMin: fc.oneof({ weight: 3, arbitrary: fc.constant('1') }, { weight: 2, arbitrary: textoNumerico }),
    maxRunsPerDay: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 1, max: 500 }).map(String) },
      { weight: 2, arbitrary: fc.constantFrom('', '   ') },
      { weight: 2, arbitrary: textoNumerico },
    ),
    conditions: fc.array(
      fc.record({
        metric: fc.constantFrom(...METRICAS),
        op: fc.constantFrom(...OPS),
        value: fc.oneof({ weight: 4, arbitrary: numeroBienEscrito }, { weight: 2, arbitrary: textoNumerico }),
      }),
      { maxLength: 3 },
    ),
  })
  .map((campos) => formBase(campos));

// Feature: parseo-montos-anuncios, Property 3: ningún payload lleva un número que
// el texto no dice
//
// **Validates: Requirements 2.6, 2.8, 3.9, 3.10**
describe('Property 3: el payload es fiel al texto', () => {
  it('para todo FormEstado que habilite Guardar, cada número del payload es el que su texto dice y cada campo vacío es null', () => {
    let guardables = 0;
    let conPresupuesto = 0;
    let conCondiciones = 0;

    fc.assert(
      fc.property(genForm, (f) => {
        // El payload no existe cuando hay problema: el botón está deshabilitado y
        // `payloadDeForm` no se llama. No hay nada que afirmar sobre un payload
        // que nadie arma.
        if (problema(f) !== null) return;
        guardables++;

        const p = payloadDeForm(f);
        // Los tres campos de presupuesto sólo viajan cuando la acción es de
        // presupuesto; con `pause` o `activate` el payload los manda en `null`
        // aunque el formulario tenga texto escrito (queda de una acción anterior).
        const ep = f.action === 'budget_increase' || f.action === 'budget_decrease';
        if (ep) conPresupuesto++;
        if (f.conditions.length > 0) conCondiciones++;

        const verificar = (clave: string, texto: string, enPayload: unknown, activo: boolean): void => {
          const contexto = `${clave} = ${JSON.stringify(texto)}`;
          if (!activo) {
            expect(enPayload, `${contexto}: el campo no aplica a esta acción`).toBeNull();
            return;
          }

          const r = numeroDeCampo(texto);
          if (r.estado === 'vacio') {
            // 3.10: el vacío es «sin límite», no «cero». Un 0 en el techo de una
            // regla es un techo de cero euros y en una condición es «pausá todo».
            expect(enPayload, `${contexto}: el vacío viaja como null`).toBeNull();
            expect(enPayload, `${contexto}: el vacío NUNCA viaja como 0`).not.toBe(0);
            return;
          }

          // Si Guardar está habilitado, ningún campo puede estar en `error`: eso es
          // lo que hace inalcanzable el `null` del caso `error` en `valorONull` (y
          // lo que lo deja como `null` y no como 0 por si algún día ese camino se
          // abre).
          expect(r.estado, `${contexto}: un campo en error no puede habilitar Guardar`).toBe('ok');
          if (r.estado !== 'ok') return;

          // Oráculo 1: el número del payload es el que leyó el mismo parseo que
          // validó el texto.
          expect(enPayload, `${contexto}: el payload lleva otro número que el parseo`).toBe(r.valor);
          expect(Number.isNaN(enPayload as number), `${contexto}: NaN en el payload`).toBe(false);

          // Oráculo 2, independiente del arreglo: para estos dos formatos el
          // número que el texto dice se puede escribir a mano. Es el oráculo que
          // el bug original rompía —`Number('1.000')` daba 1— y el que verifica
          // que la coma decimal llega entera hasta el payload (2.2).
          const t = texto.trim();
          if (/^\d+$/.test(t)) {
            expect(enPayload, `${contexto}: sólo dígitos, el número es el literal`).toBe(Number(t));
          }
          if (/^\d+,\d{1,2}$/.test(t)) {
            expect(enPayload, `${contexto}: coma decimal`).toBe(Number(t.replace(',', '.')));
          }
        };

        verificar('actionValue', f.actionValue, p.actionValue, ep);
        verificar('budgetMax', f.budgetMax, p.budgetMax, ep);
        verificar('budgetMin', f.budgetMin, p.budgetMin, ep);
        verificar('maxRunsPerDay', f.maxRunsPerDay, p.maxRunsPerDay, true);

        const condiciones = p.conditions as readonly { value: unknown }[];
        expect(condiciones).toHaveLength(f.conditions.length);
        f.conditions.forEach((c, i) => {
          verificar(`conditions[${i}].value`, c.value, condiciones[i]!.value, true);
          // Una condición no tiene caso vacío: `problemaCondiciones` rechaza el
          // valor en blanco con su propio mensaje, así que si el formulario se
          // puede guardar toda condición trae un número (3.9).
          expect(condiciones[i]!.value, `conditions[${i}] sin valor`).not.toBeNull();
        });
      }),
      { numRuns: 500 },
    );

    // LA PROPIEDAD NO ES VACÍA, y esto lo mide en lugar de suponerlo: si un cambio
    // en el generador o en la validación dejara todos los formularios bloqueados,
    // las aserciones de arriba no se ejecutarían NUNCA y el test seguiría verde.
    // Los pisos están muy por debajo de lo medido (≈140, ≈59 y ≈96 de 500) para
    // que no dependan de la semilla.
    expect(guardables, 'formularios que habilitaron Guardar').toBeGreaterThan(30);
    expect(conPresupuesto, 'payloads con acción de presupuesto').toBeGreaterThan(10);
    expect(conCondiciones, 'payloads con al menos una condición').toBeGreaterThan(10);
  });

  // El ancla concreta de la propiedad: un formulario guardable con los cinco
  // campos escritos de una forma distinta cada uno. Va aparte de la property para
  // que el caso sea reproducible sin depender de la semilla, y porque es el que se
  // lee cuando alguien quiere saber qué significa «fiel».
  it('un formulario con los cinco campos escritos de formas distintas viaja con los cinco números intactos', () => {
    const f = formBase({
      action: 'budget_increase',
      actionUnit: 'fixed',
      actionValue: '1000', // mil, no uno: es el número del bug
      budgetMax: '2.500,75', // agrupación de miles Y coma decimal
      budgetMin: '0,50', // coma decimal sola
      maxRunsPerDay: '12',
      conditions: [
        { metric: 'spend', op: '>', value: '1000' },
        { metric: 'roas', op: '<=', value: '1,25' },
      ],
    });

    expect(problema(f), 'el formulario del ancla tiene que ser guardable').toBeNull();
    const p = payloadDeForm(f);
    expect(p.actionValue).toBe(1000);
    expect(p.budgetMax).toBe(2500.75);
    expect(p.budgetMin).toBe(0.5);
    expect(p.maxRunsPerDay).toBe(12);
    expect(p.conditions).toEqual([
      { metric: 'spend', op: '>', value: 1000 },
      { metric: 'roas', op: '<=', value: 1.25 },
    ]);
  });
});
