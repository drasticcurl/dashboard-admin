/**
 * Tests de `anchosParaGuardar` — el centinela de ancho que rompía el guardado
 * de una Vista.
 *
 * El error real, reportado en producción:
 *
 *     No se pudo guardar la Vista: Number must be greater than or equal to 48
 *     (repo.vistas.0.columnas.1.ancho)
 *
 * El primer test de acá es literalmente ese caso: el estado con el que arranca
 * el Gestor, pasado por `vistaSchema`. Sin la normalización falla; con ella pasa.
 * Se valida contra el SCHEMA DE VERDAD y no contra un número esperado a mano,
 * así que si algún día se mueve `ANCHO_MIN` el test sigue midiendo lo que
 * importa: que lo que se manda es aceptable para el endpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  ANCHO_MAX,
  ANCHO_MIN,
  anchosParaGuardar,
  vistaSchema,
} from './vistas';

/** Una Vista armada con las columnas que se le pasen, para probar el schema. */
function vistaCon(columnas: { clave: string; ancho: number }[]) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    nombre: 'Mi vista',
    columnas,
    orden: { clave: 'gastos', dir: 'desc' as const },
  };
}

/**
 * El estado con el que arranca el Gestor: `nombre` con el centinela 0 («sin
 * declarar»), que TablaAds traduce a un % del ancho visible.
 */
const COLUMNAS_DEL_GESTOR = [
  { clave: 'seleccion', ancho: 48 },
  { clave: 'nombre', ancho: 0 },
  { clave: 'estado', ancho: 110 },
  { clave: 'presupuesto', ancho: 150 },
  { clave: 'gastos', ancho: 110 },
];

describe('anchosParaGuardar', () => {
  it('reproduce el bug: sin normalizar, el schema rechaza el centinela 0', () => {
    const r = vistaSchema.safeParse(vistaCon(COLUMNAS_DEL_GESTOR));
    expect(r.success).toBe(false);
    if (!r.success) {
      const problema = r.error.issues.find((i) => i.path.join('.') === 'columnas.1.ancho');
      // `columnas.1` es `nombre`: exactamente la ruta del mensaje reportado.
      expect(problema).toBeDefined();
      expect(problema!.message).toContain('48');
    }
  });

  it('normalizado, la MISMA vista pasa el schema', () => {
    const r = vistaSchema.safeParse(vistaCon(anchosParaGuardar(COLUMNAS_DEL_GESTOR)));
    expect(r.success).toBe(true);
  });

  it('el centinela de `nombre` se resuelve a un ancho estable y NO al medido en pantalla', () => {
    const [, nombre] = anchosParaGuardar(COLUMNAS_DEL_GESTOR);
    // 280, el mismo arranque que usa columnasParaRender. Estable a propósito: el
    // 34 % del viewport daría un ancho distinto según la pantalla de quien guarda.
    expect(nombre).toEqual({ clave: 'nombre', ancho: 280 });
  });

  it('no toca los anchos que ya son válidos', () => {
    const r = anchosParaGuardar([
      { clave: 'estado', ancho: 110 },
      { clave: 'presupuesto', ancho: 150 },
    ]);
    expect(r).toEqual([
      { clave: 'estado', ancho: 110 },
      { clave: 'presupuesto', ancho: 150 },
    ]);
  });

  it('acota los dos extremos: el schema también rechaza por `max`', () => {
    const r = anchosParaGuardar([
      { clave: 'estado', ancho: 5 },
      { clave: 'gastos', ancho: 9999 },
    ]);
    expect(r[0]!.ancho).toBe(ANCHO_MIN);
    expect(r[1]!.ancho).toBe(ANCHO_MAX);
  });

  it('un ancho negativo cuenta como centinela y no se acota a 48 por accidente', () => {
    // `<= 0` y no `=== 0`: un negativo sólo puede venir de un cálculo roto, y
    // resolverlo al default de la columna es más útil que dejarlo en el mínimo.
    const [nombre] = anchosParaGuardar([{ clave: 'nombre', ancho: -12 }]);
    expect(nombre!.ancho).toBe(280);
  });

  it('redondea: el % medido en pantalla da decimales y el schema pide un entero', () => {
    const [c] = anchosParaGuardar([{ clave: 'estado', ancho: 110.6 }]);
    expect(c!.ancho).toBe(111);
    expect(Number.isInteger(c!.ancho)).toBe(true);
  });

  it('una columna desconocida sin ancho cae en el mínimo, no en 0', () => {
    const [c] = anchosParaGuardar([{ clave: 'ctr', ancho: 0 }]);
    expect(c!.ancho).toBe(ANCHO_MIN);
  });

  it('preserva el orden y la cantidad de columnas', () => {
    const r = anchosParaGuardar(COLUMNAS_DEL_GESTOR);
    expect(r.map((c) => c.clave)).toEqual(COLUMNAS_DEL_GESTOR.map((c) => c.clave));
  });
});
