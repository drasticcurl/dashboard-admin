/**
 * Recorre app/api/** buscando route.ts y exige que TODOS estén en MAPA_API.
 * Sin esto, agregar un endpoint y olvidarse del mapa da un 403 en producción que
 * se ve como "la pantalla no carga" y no como "falta una línea en un mapa" (D5).
 *
 * Es lo que convierte "falla cerrado" (el default de `guardSeccion`) de una
 * intención en una garantía: olvidarse de mapear una ruta nueva rompe el build,
 * no produce un 403 silencioso en producción.
 *
 * NO se mockea el filesystem a propósito: este test tiene que leer el árbol de
 * verdad, que es todo su valor.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAPA_API } from '@/lib/permisos';

const RAIZ_API = path.join(process.cwd(), 'app', 'api');

/**
 * Camina `app/api/**` y devuelve el pathname de cada `route.ts`, sin barra
 * final. `app/api/data/ads/historial/route.ts` → `/api/data/ads/historial`.
 *
 * Se normaliza con `path.sep` → `/` porque en Windows el separador es `\` y las
 * claves de MAPA_API son pathnames de URL, que siempre usan `/`.
 */
function pathnamesDeRutas(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isDirectory()) {
      out.push(...pathnamesDeRutas(path.join(dir, entrada.name), path.join(rel, entrada.name)));
    } else if (entrada.name === 'route.ts') {
      // `rel` es el directorio del route relativo a app/api (p. ej.
      // 'data/ads/historial'). El pathname es /api + ese directorio, con los
      // separadores del SO pasados a '/'.
      const sub = rel.split(path.sep).filter(Boolean).join('/');
      out.push(sub === '' ? '/api' : `/api/${sub}`);
    }
  }
  return out;
}

/**
 * Rutas que MAPA_API declara pero que todavía NO existen en el árbol en esta
 * ola de trabajo, a propósito (plan §7 «olas de paralelismo» y §8):
 *
 *  · `/api/tareas*`   — las escribe T05 (ola 3). MAPA_API las declara desde ya
 *                       para que T05 y T06 se escriban contra un mapa congelado.
 *  · `/api/usuarios*` — las escribe T04 (ola 2, en paralelo con T03). Mismo motivo.
 *  · `/api/webhooks/hotmart` — el puente de Hotmart, un módulo completo pero
 *                       SIN COMMITEAR en el árbol (plan §8). Es 'publica' en el mapa.
 *
 * El allowlist es explícito y nombrado: una clave de MAPA_API que NO esté acá y
 * que NO exista en disco es un mapa que quedó mintiendo (una ruta que alguien
 * borró), y ESO tiene que romper. Cuando cada ola mergee su route, se saca la
 * entrada correspondiente de acá.
 */
const RUTAS_DECLARADAS_PERO_PENDIENTES: readonly string[] = [
  '/api/tareas',
  '/api/tareas/mover',
  '/api/tareas/links',
  '/api/tareas/comentarios',
  '/api/usuarios',
  '/api/usuarios/clave',
  '/api/webhooks/hotmart',
];

describe('MAPA_API cubre todas las routes de app/api', () => {
  const pathnames = pathnamesDeRutas(RAIZ_API);
  const claves = new Set(Object.keys(MAPA_API));

  it('encuentra las route.ts del árbol (que no está vacío)', () => {
    // Guardia contra el peor error de este test: leer 0 archivos y "pasar" en
    // verde porque no hay nada que chequear.
    expect(
      pathnames.length,
      'no se encontró ninguna route.ts bajo app/api — ¿cambió la estructura del árbol?',
    ).toBeGreaterThan(0);
  });

  it('CADA route.ts está en MAPA_API', () => {
    const faltantes = pathnames.filter((p) => !claves.has(p));
    expect(
      faltantes,
      `estas routes existen en app/api pero NO están en MAPA_API (lib/permisos.ts): ` +
        `${faltantes.join(', ')}. Agregá cada una al mapa con su sección; ` +
        `una ruta sin mapear devuelve 403 en producción (D5).`,
    ).toEqual([]);
  });

  it('ninguna clave de MAPA_API apunta a una ruta que no existe', () => {
    const enDisco = new Set(pathnames);
    const pendientes = new Set(RUTAS_DECLARADAS_PERO_PENDIENTES);
    const huerfanas = Object.keys(MAPA_API).filter(
      (clave) => !enDisco.has(clave) && !pendientes.has(clave),
    );
    expect(
      huerfanas,
      `estas claves de MAPA_API no tienen una route.ts real ni están declaradas ` +
        `como pendientes de otra ola: ${huerfanas.join(', ')}. ` +
        `Una entrada de más es una ruta que alguien borró y un mapa que quedó ` +
        `mintiendo; si es de una ola futura, agregala a ` +
        `RUTAS_DECLARADAS_PERO_PENDIENTES con el motivo.`,
    ).toEqual([]);
  });
});
