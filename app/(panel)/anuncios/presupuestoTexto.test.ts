import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsearPresupuesto, textoDeMotivo, type MotivoPresupuesto } from '@/lib/ads/presupuesto';
import { leerNumeroEscrito } from '@/lib/monto';
import { presupuestoDelDialogo } from './GestorAnuncios';
import { techoPositivo, textoDeC, textoDeCampo } from '@/lib/test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — Property 5: Un texto, dos lugares
 *
 * **Validates: Requirements 3.6**
 *
 * UN RECHAZO SIEMPRE TIENE TEXTO, Y ES EL MISMO EN LOS DOS LUGARES DONDE SE
 * MUESTRA: el borde rojo del campo (`FormularioPresupuesto`) y el motivo al lado
 * del botón Ejecutar deshabilitado (`presupuestoDelDialogo(...).bloqueo`).
 *
 * ─── POR QUÉ NO ALCANZA CON QUE LOS DOS «USEN EL MISMO CATÁLOGO» ────────────
 *
 * Hasta la task 3.3 los dos consumidores llamaban a `textoDeMotivo(parseo.motivo)`
 * por separado: la coherencia era una convención que había que acordarse de
 * respetar. Ahora los dos leen `parseo.texto`, el MISMO campo del MISMO objeto, y
 * la contradicción deja de ser posible por construcción.
 *
 * Y hay un motivo que lo volvió necesario y no sólo prolijo: `ambiguo` interpola el
 * texto que la persona escribió («"1.000" se puede leer de dos formas: escribí 1000
 * … o 1 …»), así que no existe ningún `Record` de textos fijos del que pueda salir.
 * Un consumidor que llamara a `textoDeMotivo('ambiguo')` mostraría el texto de
 * RESPALDO y la persona perdería justo lo que 2.1 le promete: las dos escrituras
 * entre las que elegir. Esta propiedad afirma que eso no pasa.
 *
 * ─── QUÉ QUEDA VERIFICADO Y QUÉ NO ──────────────────────────────────────────
 *
 * La suite corre en node sin render (`vitest.config.ts` toma `.test.ts` y no
 * `.test.tsx`), así que el lado del CAMPO se verifica **por composición y no por
 * render**, que es la vía que el repo ya usa para esta pantalla:
 *
 *   · VERIFICADO acá: el objeto que el campo consume —`parsearPresupuesto(valor,
 *     techoEur)`, la misma y única llamada que hace el cuerpo de
 *     `FormularioPresupuesto`— expone siempre un `texto` no vacío en su rama de
 *     rechazo, y ese `texto` es exactamente la cadena que `presupuestoDelDialogo`
 *     pone en `bloqueo`.
 *   · NO VERIFICADO acá: que el JSX pinte ese `texto` en el `<span>` de ayuda del
 *     campo. Es una línea de render (`{valor !== '' && !parseo.ok ? parseo.texto :
 *     …}`) y afirmarla sin render obligaría a extraer algo del componente. **No se
 *     extrajo**: mover código de producción en una task que sólo agrega tests es
 *     peor que dejar la línea anotada. Se lee en el archivo, es un ternario sobre
 *     el mismo `parseo`, y el borde rojo (`aria-invalid`) sale del mismo booleano.
 *
 * ─── EL HUECO QUE ESTE ARCHIVO CIERRA ───────────────────────────────────────
 *
 * `lib/ads/presupuesto.test.ts` recorre CINCO motivos en su test de
 * `textoDeMotivo` y no incluye `ambiguo`, que es el sexto. La task 3.6 lo dejó así
 * a propósito: el chequeo del catálogo completo es de esta task. Acá está, y
 * escrito de forma que sumar un motivo sin ejemplo alcanzable NO COMPILE.
 *
 * Todo es puro: no hay base, ni red, ni render.
 */

/**
 * Los textos con los que se mide, pesados hacia los que producen rechazo con
 * motivo: es el único camino donde hay un `texto` que comparar.
 *
 * La rama de cuatro decimales con coma está por una razón medible: sin ella
 * `mas_de_dos_decimales` sale ~3 veces en 1000 corridas (el único texto de
 * `textoDeCampo` que lo produce es el literal `'10,005'`), y la aserción de que los
 * seis motivos aparecieron pasaría a depender de la semilla. Con ella sale ~90.
 */
const textoDelCampo: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: textoDeCampo },
  { weight: 3, arbitrary: textoDeC },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 9_999 }))
      .map(([entero, decimales]) => `${entero},${String(decimales).padStart(4, '0')}`),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);

// Feature: parseo-montos-anuncios, Property 5: un rechazo siempre tiene un texto,
// y es el mismo en los dos lugares donde se muestra
//
// **Validates: Requirements 3.6**
describe('Property 5: un texto, dos lugares', () => {
  it('para todo texto rechazado, el motivo tiene una cadena no vacía y el campo y el diálogo muestran la misma', () => {
    let rechazos = 0;
    let ambiguos = 0;
    const motivosVistos = new Set<MotivoPresupuesto>();

    fc.assert(
      fc.property(textoDelCampo, techoPositivo, (texto, techoEur) => {
        // La MISMA llamada que hace el campo en `FormularioPresupuesto` y la que
        // hace el diálogo por dentro de `presupuestoDelDialogo`.
        const parseo = parsearPresupuesto(texto, techoEur);
        const dialogo = presupuestoDelDialogo(texto, techoEur);
        const contexto = `${JSON.stringify(texto)} (techo ${techoEur})`;

        if (parseo.ok) {
          // La otra mitad: cuando hay importe no hay nada que explicar y el botón
          // no está bloqueado por ningún texto.
          expect(dialogo.bloqueo, `${contexto}: importe válido con bloqueo`).toBeNull();
          expect(dialogo.cuerpo, `${contexto}`).toEqual({ budgetEur: parseo.valor });
          return;
        }

        rechazos++;
        motivosVistos.add(parseo.motivo);

        // 1. Un rechazo SIEMPRE tiene texto. Es lo que hace imposible el borde rojo
        //    sin explicación y el botón deshabilitado sin motivo (R1 c4, c6).
        expect(parseo.texto.length, `${contexto}: rechazo sin texto`).toBeGreaterThan(0);
        expect(parseo.texto.trim(), `${contexto}: texto en blanco`).not.toBe('');

        // 2. Y es LA MISMA cadena en los dos lugares: el campo lee `parseo.texto` y
        //    el diálogo lo copia en `bloqueo`. No hay dos mensajes que puedan
        //    discrepar, hay uno.
        expect(dialogo.bloqueo, `${contexto}: el campo y el diálogo no dicen lo mismo`).toBe(parseo.texto);
        expect(dialogo.cuerpo, `${contexto}: rechazo con payload`).toBeNull();

        if (parseo.motivo === 'ambiguo') {
          ambiguos++;
          const nucleo = leerNumeroEscrito(texto);
          expect(nucleo.ok, `${contexto}: ambiguo tiene que venir del núcleo`).toBe(false);
          if (nucleo.ok || nucleo.motivo !== 'ambiguo') return;
          // 3. El único motivo que NO puede salir de un `Record` fijo: trae las dos
          //    lecturas y cita el texto que se escribió.
          expect(parseo.texto, `${contexto}: falta la lectura como miles`).toContain(nucleo.comoMiles);
          expect(parseo.texto, `${contexto}: falta la lectura como decimal`).toContain(nucleo.comoDecimal);
          expect(parseo.texto, `${contexto}: no cita el texto escrito`).toContain(texto.trim());
          // Y no es el texto de respaldo del catálogo: si alguien vuelve a armar el
          // mensaje con `textoDeMotivo(motivo)`, esta aserción es la que se rompe.
          expect(parseo.texto, `${contexto}: salió el texto de respaldo`).not.toBe(textoDeMotivo('ambiguo'));
        } else {
          // 4. Los cinco motivos de texto fijo sí salen del catálogo, palabra por
          //    palabra: `texto` no es una reescritura del mensaje, es el mismo.
          expect(parseo.texto, `${contexto}: ${parseo.motivo} no coincide con el catálogo`).toBe(
            textoDeMotivo(parseo.motivo),
          );
        }
      }),
      { numRuns: 1_000 },
    );

    // La propiedad no es vacía: hubo rechazos, hubo ambiguos y aparecieron los seis
    // motivos. Los pisos están holgados para no depender de la semilla.
    expect(rechazos, 'textos rechazados').toBeGreaterThan(100);
    expect(ambiguos, 'textos rechazados por ambigüedad').toBeGreaterThan(20);
    expect([...motivosVistos].sort(), 'motivos que el generador alcanzó').toEqual([
      'ambiguo',
      'bajo_el_minimo',
      'mas_de_dos_decimales',
      'no_numero',
      'sobre_el_techo',
      'vacio',
    ]);
  });

  /**
   * EL CATÁLOGO COMPLETO, con un ejemplo alcanzable por motivo.
   *
   * Es un `Record<MotivoPresupuesto, …>`, así que sumar un motivo al enum sin darle
   * un ejemplo acá NO COMPILA. Eso es lo mismo que hace `TEXTO_MOTIVO` en
   * `lib/ads/presupuesto.ts` con los mensajes, un nivel más arriba: un motivo nuevo
   * necesita mensaje Y necesita un texto que lo produzca, o no entra.
   *
   * El techo de cada ejemplo es 100 EUR salvo donde el motivo depende de él.
   */
  const EJEMPLO: Record<MotivoPresupuesto, { texto: string; techo: number }> = {
    vacio: { texto: '   ', techo: 100 },
    no_numero: { texto: 'abc', techo: 100 },
    ambiguo: { texto: '1.000', techo: 100 },
    bajo_el_minimo: { texto: '0', techo: 100 },
    sobre_el_techo: { texto: '5000', techo: 100 },
    mas_de_dos_decimales: { texto: '10,005', techo: 100 },
  };

  it('los SEIS motivos tienen mensaje no vacío, son alcanzables, y el catálogo sigue siendo un Record completo', () => {
    const motivos = Object.keys(EJEMPLO) as MotivoPresupuesto[];
    // Si mañana son siete, este número lo dice en lugar de dejarlo pasar.
    expect(motivos, 'el enum de motivos').toHaveLength(6);
    expect(motivos, 'el sexto motivo es el que la task 3.3 agregó').toContain('ambiguo');

    for (const motivo of motivos) {
      const { texto, techo } = EJEMPLO[motivo];
      // El mensaje del catálogo existe para los seis, incluido el de respaldo de
      // `ambiguo` (que el rechazo real no usa, pero que tiene que estar para que el
      // `Record` compile y para un `title` o un log que sólo tenga el motivo).
      expect(textoDeMotivo(motivo).length, `mensaje de ${motivo}`).toBeGreaterThan(0);

      // Y el motivo es ALCANZABLE: un catálogo completo de motivos que nadie puede
      // producir no dice nada sobre la pantalla.
      const parseo = parsearPresupuesto(texto, techo);
      expect(parseo.ok, `${JSON.stringify(texto)} tiene que rechazarse`).toBe(false);
      if (parseo.ok) continue;
      expect(parseo.motivo, `${JSON.stringify(texto)}`).toBe(motivo);
      expect(presupuestoDelDialogo(texto, techo).bloqueo, `bloqueo de ${motivo}`).toBe(parseo.texto);
      if (motivo === 'ambiguo') {
        // Las dos lecturas de «1.000», que son la razón de ser del motivo.
        expect(parseo.texto).toContain('1000');
        expect(parseo.texto).not.toBe(textoDeMotivo('ambiguo'));
      } else {
        expect(parseo.texto, `texto de ${motivo}`).toBe(textoDeMotivo(motivo));
      }
    }
  });
});
