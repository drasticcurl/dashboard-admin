/**
 * GET /api/widget — el resultado de hoy del General, para un widget del celular.
 *
 * Lo llama un widget de Android (la app HTTP Shortcuts, ver COMO-DEPLOYAR.md)
 * que NO tiene la cookie del panel ni puede hacer el login: por eso está fuera
 * del matcher del middleware ('publica' en MAPA_API) y se autentica con un
 * token largo propio, `WIDGET_TOKEN`, en el header `Authorization: Bearer …`.
 * Nunca en la query: una URL con el token queda en los logs de Caddy.
 *
 * Sin `WIDGET_TOKEN` configurado responde 404: la instancia que no lo declara
 * no tiene la feature, y no hay un token vacío que adivinar.
 *
 * El número es el mismo que el aviso push y el widget Resultado del Resumen
 * General: `totals.resultEur` de `getOverviewData` con hoy..hoy en
 * DASHBOARD_TZ, después de traer el gasto de Meta al día.
 *
 * `?formato=texto` devuelve dos líneas de texto plano (lo que muestra el
 * widget); sin él, JSON.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { today } from '@/lib/day';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { getOverviewData, resolverAlcanceResumen } from '@/lib/queries/overview';
import { SIMBOLO_REPORTE } from '@/lib/moneda-reporte';
import { formatearMonto, tramoDe } from '@/lib/push/mensajes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };

/** SHA-256 de los dos lados: así timingSafeEqual compara largos iguales siempre. */
function tokenValido(recibido: string, esperado: string): boolean {
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const esperado = process.env.WIDGET_TOKEN?.trim();
  if (!esperado) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  const auth = req.headers.get('authorization') ?? '';
  const recibido = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!recibido || !tokenValido(recibido, esperado)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });
  }

  const { timezone } = await resolverAlcanceResumen(null);
  const hoy = await today(timezone);

  // Igual que el Resumen: gasto de Meta al día antes de leer. 15 s de tope para
  // que el widget no quede colgado; si Meta no contesta se muestra lo guardado.
  const frescura = await ensureFreshAdSpend(hoy, hoy, { timeoutMs: 15_000 });

  const { totals } = await getOverviewData({ from: hoy, to: hoy });
  const tramo = tramoDe({
    resultado: totals.resultEur,
    roi: totals.roi,
    ventas: totals.orders,
    gasto: totals.adSpendEur,
  });
  const emoji =
    tramo === 'fuego' || tramo === 'ganancia' ? '🟢' : tramo === 'perdida' || tramo === 'catastrofe' ? '🔴' : '⚪';

  const resultado = formatearMonto(totals.resultEur, SIMBOLO_REPORTE);
  const gasto = formatearMonto(totals.adSpendEur, SIMBOLO_REPORTE).replace('+', '');
  const neto = formatearMonto(totals.netEur, SIMBOLO_REPORTE).replace('+', '');
  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());

  const linea1 = `${emoji} Hoy ${resultado}`;
  const linea2 =
    `${totals.orders} ${totals.orders === 1 ? 'venta' : 'ventas'} · neto ${neto} · gasto ${gasto}` +
    (totals.roi !== null ? ` · ROI ${totals.roi.toFixed(2)}×` : '') +
    ` · ${hora}`;

  if (req.nextUrl.searchParams.get('formato') === 'texto') {
    return new NextResponse(`${linea1}\n${linea2}`, {
      headers: { ...SIN_CACHE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return NextResponse.json(
    {
      ok: true,
      dia: hoy,
      hora,
      tramo,
      resultado: totals.resultEur,
      neto: totals.netEur,
      gasto: totals.adSpendEur,
      ventas: totals.orders,
      roi: totals.roi,
      texto: `${linea1}\n${linea2}`,
      gastoAlDia: !frescura.error,
    },
    { headers: SIN_CACHE },
  );
}
