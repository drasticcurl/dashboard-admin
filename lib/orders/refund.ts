import { getPool } from '../db';

/**
 * Devolución/cancelación de una venta (plan §5, task T04 §6).
 *
 * La fila NO se borra y NO se resta de orders_count: bruto, devuelto y neto
 * son tres números distintos y el panel muestra los tres. La sesión tampoco
 * se desmarca: sessions.purchased_at registra que la compra ocurrió, y
 * ocurrió.
 */

export type RefundResult = { found: boolean };

export async function refundOrder(orderId: string | number | undefined): Promise<RefundResult> {
  if (orderId == null) return { found: false };
  const res = await getPool().query(
    `UPDATE orders
     SET status = 'refunded', refunded_at = COALESCE(refunded_at, now()), updated_at = now()
     WHERE source = 'shopify' AND external_id = $1`,
    [`shopify_${orderId}`],
  );
  // found=false → devolución de una orden anterior a este sistema: el caller
  // registra status='error' con error='order_not_found' y responde 200 igual.
  return { found: (res.rowCount ?? 0) > 0 };
}
