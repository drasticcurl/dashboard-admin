/**
 * Envío de notificaciones push de la PWA (server-only).
 *
 * `web-push` habla directo con el servicio push del navegador (Apple, Google o
 * Mozilla), firmando con un par de claves VAPID que identifica a ESTE panel. No
 * hay Firebase ni intermediario.
 *
 * Las claves se leen del entorno en cada envío (`VAPID_PUBLIC_KEY`,
 * `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), no al importar: así el build y los
 * tests no las necesitan. Se generan una vez con
 *   npx web-push generate-vapid-keys
 * y NO se rotan a la ligera: el navegador sólo acepta mensajes firmados con la
 * clave pública con la que se suscribió, así que cambiarlas obliga a reactivar
 * los avisos en cada celular. Cada instancia (hilvanapp, infinix) tiene las suyas.
 *
 * Una suscripción que responde 404/410 está muerta (desinstalaron la app,
 * borraron datos, sacaron el permiso) y se borra. Cualquier otro error es
 * transitorio: se loguea y queda para el próximo aviso.
 */

import webpush, { WebPushError } from 'web-push';
import { q } from '../db';

export type Vapid = { publicKey: string; privateKey: string; subject: string };

export function leerVapid(): Vapid | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@example.com';
  return { publicKey, privateKey, subject };
}

export type Notificacion = {
  titulo: string;
  cuerpo: string;
  url?: string;
  tag?: string;
  /** Ícono grande del aviso (Android; iOS lo ignora). Default el de la app. */
  icono?: string;
  /** Quién la recibe: admins y quien tenga esta sección. Default 'resumen'. */
  seccion?: 'resumen' | 'ventas';
  /** Segundos que el servicio push la guarda si el celular está apagado. Default 2 h. */
  ttl?: number;
  urgencia?: 'normal' | 'high';
};

type SuscripcionRow = { id: number; endpoint: string; p256dh: string; auth: string };

export type ResultadoEnvio = { configurado: boolean; enviados: number; borrados: number; fallidos: number };

/**
 * Manda la notificación a todas las suscripciones de usuarios ACTIVOS que pueden
 * ver la sección del aviso (el profit es un número del Resumen, cada venta es una
 * fila de Ventas: quien no tiene esa pestaña no tiene por qué recibirlo).
 */
export async function enviarATodos(n: Notificacion): Promise<ResultadoEnvio> {
  const vapid = leerVapid();
  if (!vapid) return { configurado: false, enviados: 0, borrados: 0, fallidos: 0 };

  const subs = await q<SuscripcionRow>(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM push_suscripciones s
       JOIN usuarios u ON u.id = s.usuario_id
      WHERE u.activo
        AND (u.es_admin OR EXISTS (
              SELECT 1 FROM usuario_secciones us
               WHERE us.usuario_id = u.id AND us.seccion = $1))`,
    [n.seccion ?? 'resumen'],
  );

  const payload = JSON.stringify({ title: n.titulo, body: n.cuerpo, url: n.url ?? '/resumen', tag: n.tag, icon: n.icono });
  let enviados = 0;
  let borrados = 0;
  let fallidos = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          {
            vapidDetails: vapid,
            // 2 h por default: si el celular estuvo apagado más que eso, el profit
            // ya es viejo y el próximo aviso lo reemplaza.
            TTL: n.ttl ?? 2 * 60 * 60,
            urgency: n.urgencia ?? 'normal',
            timeout: 10_000,
          },
        );
        enviados += 1;
        await q('UPDATE push_suscripciones SET ultimo_ok_at = now() WHERE id = $1', [s.id]);
      } catch (err) {
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          borrados += 1;
          await q('DELETE FROM push_suscripciones WHERE id = $1', [s.id]);
          return;
        }
        fallidos += 1;
        const detalle = err instanceof WebPushError ? `${err.statusCode} ${err.body}` : String(err);
        console.error(`push: falló la suscripción ${s.id}: ${detalle}`);
      }
    }),
  );

  return { configurado: true, enviados, borrados, fallidos };
}
