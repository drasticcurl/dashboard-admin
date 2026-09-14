/**
 * Contrato A (checkout-kashhhpay/tasks/panel-y-capi/00-PLAN-PANEL-Y-CAPI.md §4)
 * — el payload que checkout-kashhhpay manda a POST /api/webhooks/checkout-propio.
 *
 * ESPEJO: checkout-kashhhpay/lib/capi-tipos.ts declara el mismo tipo con el
 * mismo nombre. Si cambiás este archivo, cambiá el otro. No hay paquete
 * compartido entre los dos repos — son proyectos Next.js independientes —
 * así que la sincronización es manual y a propósito.
 */
export type PayloadVentaCheckoutPropio = {
  cobroId: string;
  whopPlanId: string;
  email: string | null;
  monto: string;
  moneda: string;
  purchasedAt: string;
  utms: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
  };
  fbclid?: string;
  sessionId?: string;
  visitorId?: string;
};

export type RespuestaVentaCheckoutPropio =
  | { ok: true; orderId: number; isNew: boolean; funnelId: number | null }
  | { ok: true; orderId: null; isNew: false }
  | { ok: false; error: string };
