/**
 * Aviso push por cada venta nueva (server-only).
 *
 * Lo llaman los webhooks de Shopify y de checkout propio DESPUÉS de guardar la
 * orden, sin esperarlo: Shopify corta el webhook a los 5 s y un servicio push
 * lento no puede hacer que reintente la venta. Por eso esta función nunca tira:
 * cualquier error queda en el log y la venta ya está guardada.
 *
 * Lee la orden de la base (y no del payload) para que los dos webhooks avisen
 * igual: tier, monto y funnel ya resueltos por el upsert.
 *
 * `PUSH_VENTAS=0` en el entorno lo apaga sin tocar el aviso del profit.
 */

import { q1 } from '../db';
import { enviarATodos } from './enviar';
import { armarAvisoVenta } from './mensajes';

/** Una orden que llega con más de esto de atraso (reproceso, backfill) no avisa. */
const MAX_ATRASO_MS = 2 * 60 * 60 * 1000;

type OrdenRow = {
  tier: string;
  amount: string;
  currency: string;
  order_number: string | null;
  funnel: string | null;
  purchased_at: Date;
  bump: string;
};

export async function avisarVenta(orderId: number): Promise<void> {
  if (process.env.PUSH_VENTAS === '0') return;
  try {
    const o = await q1<OrdenRow>(
      `SELECT o.tier, o.amount, o.currency, o.order_number, f.name AS funnel, o.purchased_at,
              (SELECT COALESCE(SUM(i.amount * i.quantity), 0) FROM order_items i
                WHERE i.order_id = o.id AND i.tier = 'bump') AS bump
         FROM orders o LEFT JOIN funnels f ON f.id = o.funnel_id
        WHERE o.id = $1 AND o.status = 'approved'`,
      [orderId],
    );
    if (!o) return;
    if (Date.now() - new Date(o.purchased_at).getTime() > MAX_ATRASO_MS) return;

    const { titulo, cuerpo, tipo } = armarAvisoVenta({
      tier: o.tier,
      amount: Number(o.amount),
      currency: o.currency,
      numero: o.order_number,
      funnel: o.funnel,
      bump: Number(o.bump),
    });
    const r = await enviarATodos({
      titulo,
      cuerpo,
      url: '/ventas',
      // Un tag por orden: las ventas se apilan en la bandeja, no se pisan.
      tag: `venta-${orderId}`,
      icono: tipo === 'front' ? '/pwa/venta-front.png' : '/pwa/venta-upsell.png',
      seccion: 'ventas',
      ttl: 24 * 60 * 60,
      urgencia: 'high',
    });
    if (r.fallidos > 0) console.error(`push: venta ${orderId}: ${r.fallidos} envíos fallidos`);
  } catch (err) {
    console.error(`push: no se pudo avisar la venta ${orderId}:`, err);
  }
}
