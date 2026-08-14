/**
 * Tipos del payload de Shopify (parcial, solo lo que usa el webhook). Son el
 * mismo subconjunto que el webhook de producción de testfunnel (que ya está
 * afinado contra payloads reales); se copian, no se re-inventan.
 */

export type ShopifyCustomer = {
  email?: string;
  first_name?: string;
  last_name?: string;
};

export type ShopifyLineItem = {
  product_id?: number | string;
  variant_id?: number | string;
  title?: string;
  name?: string;
  price?: string;
  quantity?: number;
};

/** Pares clave/valor que Shopify adjunta a la orden (cart/note attributes). */
export type ShopifyNoteAttribute = {
  name?: string;
  value?: string;
};

export type ShopifyAddress = {
  country_code?: string;
};

export type ShopifyOrder = {
  id?: number | string;
  order_number?: number | string;
  name?: string;
  email?: string;
  contact_email?: string;
  customer?: ShopifyCustomer;
  financial_status?: string;
  total_price?: string;
  current_total_price?: string;
  currency?: string;
  created_at?: string;
  processed_at?: string;
  line_items?: ShopifyLineItem[];
  /** URL (con query) donde el cliente aterrizó en la tienda → trae los UTMs. */
  landing_site?: string;
  referring_site?: string;
  /** Atributos del carrito/nota (canal confiable de atribución, D10/D11). */
  note_attributes?: ShopifyNoteAttribute[];
  billing_address?: ShopifyAddress;
  shipping_address?: ShopifyAddress;
};

/** Payload de refunds/create: trae order_id, no el order completo. */
export type ShopifyRefund = {
  id?: number | string;
  order_id?: number | string;
};
