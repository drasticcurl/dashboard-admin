/**
 * /anuncios/reglas — lista de reglas + formulario (T19).
 *
 * Server component: `force-dynamic` y el fetch inicial acá para que la primera
 * pintura ya tenga las reglas, los interruptores y las cuentas. Las mutaciones
 * y recargas las maneja `ReglasView` en el client contra `/api/ads/reglas` y
 * `/api/ads/interruptores`.
 */

import { ReglasView } from './ReglasView';
import { leerInterruptores, listarCuentas, listarReglas } from './_server';

export const dynamic = 'force-dynamic';

export default async function ReglasPage() {
  const [reglas, interruptores, cuentas] = await Promise.all([
    listarReglas(),
    leerInterruptores(),
    listarCuentas(),
  ]);

  return <ReglasView initial={{ reglas, interruptores, cuentas }} />;
}
