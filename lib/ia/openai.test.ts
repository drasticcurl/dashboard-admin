/**
 * Tests del schema de salida. NO llama a OpenAI: no hay key en los tests y una
 * suite que dependa de una API paga no se puede correr en cada commit.
 *
 * ─── QUE VERIFICA Y POR QUE VALE ───────────────────────────────────────────
 * `strict: true` tiene dos requisitos que la API valida ANTES de mirar el
 * prompt, y si alguno falta contesta 400 rechazando el schema:
 *
 *   · todo objeto tiene que declarar `additionalProperties: false`
 *   · toda propiedad de un objeto tiene que estar listada en `required`
 *
 * Es el modo de falla más probable de este módulo cuando alguien agregue un campo
 * al insight (un `prioridad`, un `href`): se agrega a `properties`, se olvida de
 * `required`, y la feature entera empieza a devolver 400 con un mensaje sobre
 * JSON Schema que no se parece en nada a "te falta una línea". El test lo dice en
 * castellano y sin gastar un centavo.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_SALIDA, modelo } from './openai';

type Nodo = {
  type?: string;
  properties?: Record<string, Nodo>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Nodo;
  enum?: readonly string[];
};

/** Todos los subesquemas de tipo object, con su ruta, para poder reportar cuál falla. */
function objetos(nodo: Nodo, ruta = 'raíz'): { ruta: string; nodo: Nodo }[] {
  const encontrados: { ruta: string; nodo: Nodo }[] = [];
  if (nodo.type === 'object') encontrados.push({ ruta, nodo });
  if (nodo.properties) {
    for (const [k, v] of Object.entries(nodo.properties)) {
      encontrados.push(...objetos(v, `${ruta}.${k}`));
    }
  }
  if (nodo.items) encontrados.push(...objetos(nodo.items, `${ruta}[]`));
  return encontrados;
}

const SCHEMA = SCHEMA_SALIDA as unknown as Nodo;

describe('SCHEMA_SALIDA cumple los requisitos de strict: true', () => {
  it('todo objeto declara additionalProperties: false', () => {
    for (const { ruta, nodo } of objetos(SCHEMA)) {
      expect(nodo.additionalProperties, `falta additionalProperties: false en ${ruta}`).toBe(false);
    }
  });

  it('todo objeto lista TODAS sus propiedades en required', () => {
    for (const { ruta, nodo } of objetos(SCHEMA)) {
      const props = Object.keys(nodo.properties ?? {}).sort();
      const req = [...(nodo.required ?? [])].sort();
      expect(req, `required incompleto en ${ruta}`).toEqual(props);
    }
  });

  it('encontró los tres objetos del schema, así que el recorrido no es vacío', () => {
    // Sin esto, un bug en `objetos()` que devolviera [] haría pasar los dos tests
    // de arriba sin verificar nada.
    expect(objetos(SCHEMA).map((o) => o.ruta)).toEqual([
      'raíz',
      'raíz.insights[]',
      'raíz.insights[].evidencia[]',
    ]);
  });

  it('los tonos del enum son los tokens semánticos de tailwind, sin inventar ninguno', () => {
    // El `tono` se pasa tal cual a `<Banner tone={...}>`. Un valor que no esté en
    // el mapa de Banner rompe el render con un undefined en las clases.
    const tono = SCHEMA.properties!.insights!.items!.properties!.tono!;
    expect(tono.enum).toEqual(['good', 'warn', 'bad', 'info']);
  });
});

describe('modelo()', () => {
  const original = process.env.OPENAI_MODEL;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = original;
  });

  it('cae al default cuando la env var no está', () => {
    delete process.env.OPENAI_MODEL;
    expect(modelo()).toBe('gpt-4o-mini');
  });

  it('cae al default con la env var vacía o en blanco', () => {
    // Una línea `OPENAI_MODEL=` en el .env deja el string vacío, no undefined: sin
    // el `||` el módulo mandaría `"model": ""` y la API contestaría un 400.
    process.env.OPENAI_MODEL = '   ';
    expect(modelo()).toBe('gpt-4o-mini');
  });

  it('respeta el modelo configurado', () => {
    process.env.OPENAI_MODEL = 'algo-mas-nuevo';
    expect(modelo()).toBe('algo-mas-nuevo');
  });
});
