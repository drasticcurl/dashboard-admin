/**
 * Guardián de la tabla compartida (task 19.1, spec gestion-campanas-anuncios).
 *
 * R6 c2 exige que los bordes verticales de la Tabla_Anuncios usen EL MISMO token
 * de color y EL MISMO grosor que el borde horizontal entre filas de la tabla
 * compartida de `components/ui.tsx`, y R6 c5 exige 0 píxeles de diferencia en las
 * 7 pantallas que la consumen. La garantía primaria es por construcción: este
 * repo no toca `components/ui.tsx` en ninguna task. Este test es la red
 * automatizada por si alguien lo toca después:
 *
 *   - el `Table` compartido sigue llevando `border-b border-border-subtle` en el
 *     encabezado y `border-b border-overlay/4` entre filas (los literales que
 *     `TablaAds.tsx` replica con su `BORDE_CELDA`), y
 *   - el archivo no gana ninguna utilidad de borde vertical (`border-r`,
 *     `border-x`, `divide-x`): la omisión por defecto de R6 c7 sigue siendo
 *     omisión.
 *
 * Si este test falla porque alguien CAMBIÓ el token en la tabla compartida,
 * `app/(panel)/anuncios/TablaAds.tsx` (BORDE_CELDA) es el lugar a actualizar
 * para volver a alinearlos. Si falla porque apareció un borde vertical nuevo
 * en la tabla compartida, R6 c5 se rompió: esa utilidad no va ahí.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fuente = readFileSync(fileURLToPath(new URL('./ui.tsx', import.meta.url)), 'utf8');

const TOKEN_ENCABEZADO = 'border-b border-border-subtle';
const TOKEN_FILAS = 'border-b border-overlay/4';
const UTILIDADES_VERTICALES = ['border-r', 'border-x', 'divide-x'];

describe('components/ui.tsx — tabla compartida (guardián de R6 c2, c3, c5, c7)', () => {
  it('conserva el token del borde horizontal del encabezado', () => {
    expect(
      fuente.includes(TOKEN_ENCABEZADO),
      `el Table compartido ya no contiene "${TOKEN_ENCABEZADO}". Si se cambió el token del encabezado a propósito, actualizá el encabezado de app/(panel)/anuncios/TablaAds.tsx para que R6 c2 siga valiendo.`,
    ).toBe(true);
  });

  it('conserva el token del borde horizontal entre filas de datos', () => {
    expect(
      fuente.includes(TOKEN_FILAS),
      `el Table compartido ya no contiene "${TOKEN_FILAS}". Ese es el token y el grosor que la Tabla_Anuncios replica en sus bordes verticales (BORDE_CELDA de app/(panel)/anuncios/TablaAds.tsx): si lo cambiaron, actualizalo también allá.`,
    ).toBe(true);
  });

  it('no gana ninguna utilidad de borde vertical (R6 c5, c7)', () => {
    for (const u of UTILIDADES_VERTICALES) {
      expect(
        fuente.includes(u),
        `components/ui.tsx ahora contiene "${u}", un borde vertical. La tabla compartida no puede dibujar bordes verticales: R6 c5 pide 0 píxeles de diferencia en las otras 7 pantallas, y la grilla vertical vive SOLO en app/(panel)/anuncios/TablaAds.tsx. Sacá esa utilidad de acá.`,
      ).toBe(false);
    }
  });
});
