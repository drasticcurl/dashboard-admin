/**
 * Property 6: toda clase de color literal del panel existe en la paleta
 * (spec `parseo-montos-anuncios`, tarea 7).
 *
 * **Validates: Requirements 2.15, 3.14, 3.15**
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 *
 * `hover:text-good-100` vivió en `app/(panel)/anuncios/ChipCascada.tsx` sin que
 * nada lo notara: la escala `good` va de 200 a 600, así que ese tono no existe.
 * Un tono que la paleta no define NO rompe la build, NO emite una sola regla de
 * CSS y NO aparece en ningún test — el JIT de Tailwind no conoce la clase y
 * simplemente no genera nada, así que el elemento se queda con el color de base
 * y el hover no hace nada. Es el mismo modo de falla que `bg-overlay/4` sin la
 * escala de opacidad, que ya está documentado en `tailwind.config.ts` y que
 * dejó 58 usos muertos.
 *
 * O sea: la única forma de que esto se note es un test que lo mire a propósito.
 *
 * ── Cómo ───────────────────────────────────────────────────────────────────
 *
 * Se barren `app/`, `components/` y `lib/` (los tres globs de `content` de
 * `tailwind.config.ts`), se extraen las clases escritas literalmente y se
 * comprueba cada tono contra la paleta RESUELTA: la del config mezclada con la
 * de Tailwind, que es exactamente lo que ve el JIT. Sin CLI, sin compilar CSS
 * y sin red: corre en milisegundos con el resto de la suite.
 *
 * ── Límites, declarados a propósito ────────────────────────────────────────
 *
 *  - **Sólo ve clases escritas literalmente.** Una clase armada por
 *    interpolación (`text-${tono}-300`) es invisible para este test, igual que
 *    para el JIT de Tailwind: por eso el repo las escribe completas. Hoy no hay
 *    ninguna interpolada.
 *  - **Sólo las nueve propiedades de `PROPIEDADES`.** `accent-good-500`,
 *    `outline-good-500/60` y `shadow-good-500` también son clases de color, hoy
 *    apuntan a tonos que existen y quedan fuera del barrido. Si alguna se
 *    rompe, este test no la agarra: sumar la propiedad a la lista es todo lo
 *    que hace falta.
 *  - **No mira CSS.** `app/globals.css` referencia la paleta con
 *    `theme('colors.neutral.50')`, que falla ruidosamente en la build si el
 *    tono no existe: no necesita guarda.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig';
import tailwindConfig from '@/tailwind.config';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

/**
 * El barrido se saltea este archivo, y es el único: es el único lugar del repo
 * que nombra clases rotas a propósito, en los comentarios y en el mensaje de
 * error. Tailwind lee los comentarios igual que el código (el `content` es el
 * texto crudo del archivo), así que sin esta excepción el test se marcaría a sí
 * mismo tres veces y taparía el hallazgo real.
 */
const ESTE_ARCHIVO = fileURLToPath(import.meta.url);

/** Los tres globs de `content` en `tailwind.config.ts`, sin el glob. */
const DIRECTORIOS = ['app', 'components', 'lib'];
const EXTENSIONES = ['.ts', '.tsx'];

/** Las propiedades de color que el barrido conoce (ver límites arriba). */
const PROPIEDADES = ['text', 'bg', 'border', 'ring', 'from', 'via', 'to', 'fill', 'stroke'] as const;

/** El lado de `border-t-good-400`: la clase sigue siendo de color. */
const LADOS = ['t', 'r', 'b', 'l', 'x', 'y', 's', 'e'] as const;

/**
 * Segmentos que tienen la forma de una escala pero no son de color, así que el
 * tono es un número y no un tono: `ring-offset-2` es un grosor,
 * `text-opacity-50` es el alfa viejo de v2, `border-spacing-2` es una medida.
 * Sin esta lista el test fallaría por lo que no debe.
 *
 * `border-2`, `ring-2` y `text-xs` no necesitan estar acá: no tienen la forma
 * escala+tono y el patrón ya no los toma (la escala pide dos letras como
 * mínimo, que es también lo que descarta el lado de `border-b-2`).
 * `bg-overlay/4` tampoco: su modificador va con `/`, no con `-`.
 */
const NO_SON_ESCALAS = new Set(['offset', 'opacity', 'spacing']);

/**
 * `{prefijo:}?{propiedad}{-lado}?-{escala}-{tono}`, con el tono opcionalmente
 * seguido de un modificador de alfa (`/60`), que no se captura porque el alfa
 * lo valida la escala de `opacity` y no la paleta.
 *
 * Los `(?<![\w-])` / `(?![\w-])` de los extremos son lo que evita que el
 * patrón muerda adentro de otra palabra: sin ellos, `--tw-ring-color` daría un
 * `ring-color`, y `grid-auto-rows-2` daría un `to-rows-2`.
 */
const CLASE_DE_COLOR = new RegExp(
  String.raw`(?<![\w-])((?:[a-z][a-z0-9-]*:)*)(${PROPIEDADES.join('|')})(?:-(?:${LADOS.join('|')}))?-([a-z][a-z-]*[a-z])-(\d+)(?![\w-])`,
  'g',
);

/**
 * La paleta como la ve el JIT: el `extend` del config mezclado con la de
 * Tailwind. Importa: `neutral` está sobreescrita completa en el config (50–950)
 * y `good`/`warn`/`bad`/`info` son escalas nuevas que van de 200 a 600, pero
 * las escalas por defecto de Tailwind (`emerald`, `slate`, …) siguen
 * existiendo, así que marcar una de ellas como inexistente sería un falso
 * positivo.
 */
const paleta = resolveConfig(tailwindConfig).theme.colors as unknown as Record<
  string,
  string | Record<string, string> | undefined
>;

/** Los tonos de una escala, o `null` si la escala no es una escala con tonos. */
function tonosDe(escala: string): ReadonlySet<string> | null {
  const valor = paleta[escala];
  if (valor === undefined || typeof valor === 'string') return null;
  return new Set(Object.keys(valor));
}

function archivosDe(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completa = path.join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivosDe(completa));
    else if (EXTENSIONES.includes(path.extname(entrada.name))) salida.push(completa);
  }
  return salida.sort();
}

type Uso = {
  /** La clase completa, con prefijo: `hover:text-good-100`. */
  clase: string;
  escala: string;
  tono: string;
  /** `app/(panel)/anuncios/ChipCascada.tsx:53` */
  donde: string;
};

function barrer(): Uso[] {
  const usos: Uso[] = [];
  for (const dir of DIRECTORIOS) {
    for (const archivo of archivosDe(path.join(RAIZ, dir))) {
      if (archivo === ESTE_ARCHIVO) continue;
      const relativo = path.relative(RAIZ, archivo);
      const lineas = readFileSync(archivo, 'utf8').split('\n');
      lineas.forEach((linea, i) => {
        for (const m of linea.matchAll(CLASE_DE_COLOR)) {
          // m[0] es la clase completa; los grupos son prefijo, propiedad,
          // escala y tono, en ese orden.
          const [clase, , , escala, tono] = m;
          if (NO_SON_ESCALAS.has(escala)) continue;
          usos.push({ clase, escala, tono, donde: `${relativo}:${i + 1}` });
        }
      });
    }
  }
  return usos;
}

const usos = barrer();

describe('Property 6 — toda clase de color literal del panel existe en la paleta', () => {
  it('el barrido encuentra clases (si esto falla, el test de abajo es vacío)', () => {
    // Un patrón roto, una ruta mal armada o un `content` que se movió dejarían
    // el barrido en cero y la propiedad de abajo pasaría sin mirar nada. El
    // piso es holgado a propósito: hoy son 805 usos (67 clases distintas con
    // prefijo) sobre 260 archivos, de los cuales 52 tienen alguna clase.
    expect(usos.length).toBeGreaterThan(300);
    // Las cinco escalas del panel tienen que aparecer todas.
    const escalas = new Set(usos.map((u) => u.escala));
    for (const esperada of ['neutral', 'good', 'warn', 'bad', 'info']) {
      expect(escalas, `el barrido no encontró ninguna clase de la escala "${esperada}"`).toContain(
        esperada,
      );
    }
  });

  it('todo tono usado existe en la paleta de tailwind.config.ts', () => {
    const fallas = usos
      .filter((u) => !tonosDe(u.escala)?.has(u.tono))
      .map((u) => {
        const tonos = tonosDe(u.escala);
        const detalle = tonos
          ? `la escala "${u.escala}" no define el tono "${u.tono}" (tiene: ${[...tonos].join(', ')})`
          : `"${u.escala}" no es una escala de color de la paleta`;
        return `${u.donde} → ${u.clase}: ${detalle}`;
      });

    expect(
      [...new Set(fallas)].sort(),
      'Estas clases NO emiten CSS: el tono no existe en la paleta, así que Tailwind no genera la regla y el estilo no se aplica (sin error ni aviso). Corregí el tono al más cercano que la escala defina, o agregá el tono a tailwind.config.ts.',
    ).toEqual([]);
  });
});
