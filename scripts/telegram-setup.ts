/**
 * `npm run ads:telegram` — configura el bot de Telegram sin editar archivos
 * (D-A15). El token y el chat id van a `settings`, no al env, porque cambiarlos
 * desde un script no puede obligar a reiniciar PM2.
 *
 *   npm run ads:telegram            flujo interactivo completo
 *   npm run ads:telegram -- --test  manda un mensaje de prueba con lo ya guardado
 *
 * FLUJO
 *   1. Pide el bot token (el de @BotFather) SIN eco en la terminal, para que no
 *      quede en el historial de la shell.
 *   2. Lo valida contra `getMe`. Si no valida, lo pide de nuevo: no guarda un
 *      token roto.
 *   3. Ofrece descubrir el chat id solo: el usuario manda un mensaje al bot y el
 *      script hace polling de `getUpdates` hasta que aparece un chat. Muestra el
 *      nombre y pide confirmar.
 *   4. Deja pegarlo a mano como alternativa (grupos/canales, donde getUpdates
 *      puede no verlo).
 *   5. Guarda las tres filas (`ads_telegram_bot_token`, `ads_telegram_chat_id`,
 *      `ads_telegram_enabled = true`). `settings.value` es jsonb: los strings van
 *      con JSON.stringify.
 *   6. Manda un mensaje de prueba y NO termina hasta que el usuario confirma que
 *      lo recibió. Un setup que dice "listo" sin haber entregado nada no sirve.
 *
 * NUNCA imprime el token, ni parcial. Si hace falta mostrarlo, `enmascararToken`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { q } from '../lib/db';
import { avisar, enmascararToken } from '../lib/ads/notificar';

const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Entrada ─────────────────────────────────────────────────────────────────

function preguntar(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (respuesta) => {
      rl.close();
      resolve(respuesta.trim());
    });
  });
}

/** Lee una línea SIN eco (raw mode), para el token. Soporta borrar con backspace. */
function leerSecreto(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const input = process.stdin;
    let buf = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdout.write('\n');
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          input.setRawMode(false);
          process.exit(1);
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    input.on('data', onData);
  });
}

async function confirmar(prompt: string): Promise<boolean> {
  const r = await preguntar(`${prompt} [s/N] `);
  return /^s$/i.test(r) || /^si$/i.test(r) || /^y$/i.test(r) || /^yes$/i.test(r);
}

// ─── API de Telegram ─────────────────────────────────────────────────────────

async function getMe(token: string): Promise<{ ok: boolean; username: string | null; error: string | null }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: { username?: string; first_name?: string };
    } | null;
    if (!res.ok || body?.ok !== true) {
      return { ok: false, username: null, error: body?.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, username: body.result?.username ?? null, error: null };
  } catch (e) {
    return { ok: false, username: null, error: e instanceof Error ? e.message : String(e) };
  }
}

type Update = {
  update_id?: number;
  message?: { chat?: { id?: number; title?: string; first_name?: string; username?: string } };
  channel_post?: { chat?: { id?: number; title?: string; first_name?: string; username?: string } };
};

async function getUpdates(token: string, offset: number): Promise<{ updates: Update[]; error: string | null }> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates${offset > 0 ? `?offset=${offset}` : ''}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: Update[] } | null;
    if (!res.ok || body?.ok !== true) return { updates: [], error: `getUpdates falló (HTTP ${res.status})` };
    return { updates: body?.result ?? [], error: null };
  } catch (e) {
    return { updates: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function nombreDeChat(u: Update): string | null {
  const chat = u.message?.chat ?? u.channel_post?.chat;
  if (!chat) return null;
  return chat.title ?? chat.first_name ?? chat.username ?? 'chat sin nombre';
}

/** Polling de getUpdates hasta que el usuario le manda un mensaje al bot. */
async function descubrirChat(token: string): Promise<{ id: string; nombre: string } | null> {
  // Se ignora lo que ya estaba en la cola: offset = último update_id + 1.
  let offset = 0;
  const inicial = await getUpdates(token, 0);
  const ultimo = inicial.updates[inicial.updates.length - 1];
  if (ultimo?.update_id) offset = ultimo.update_id + 1;

  console.log('\nMandale CUALQUIER mensaje al bot ahora (por ejemplo "hola").');
  console.log('Esperando... (Ctrl+C para cancelar)\n');

  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const r = await getUpdates(token, offset);
    for (const u of r.updates) {
      const chat = u.message?.chat ?? u.channel_post?.chat;
      if (chat?.id) {
        return { id: String(chat.id), nombre: nombreDeChat(u) ?? 'chat sin nombre' };
      }
    }
  }
  return null;
}

// ─── Persistencia ────────────────────────────────────────────────────────────

/** El mismo INSERT ON CONFLICT que usa `setSetting` (value es jsonb). */
async function setValor(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ─── Flujo ───────────────────────────────────────────────────────────────────

async function flujoCompleto(): Promise<void> {
  console.log('Configuración del bot de Telegram para Anuncios.\n');

  // 1-2. Token, sin eco, validado contra getMe.
  let token = '';
  let username: string | null = null;
  for (;;) {
    token = await leerSecreto('Bot token (lo da @BotFather; no se muestra al escribir): ');
    if (!token) {
      console.log('El token no puede estar vacío.\n');
      continue;
    }
    const me = await getMe(token);
    if (!me.ok) {
      console.log(`El token no valida: ${me.error}\n`);
      continue;
    }
    username = me.username;
    console.log(`Bot válido: @${username ?? '(sin username)'}.\n`);
    break;
  }

  // 3-4. Chat id: descubrir solo o pegarlo a mano.
  let chatId: string | null = null;
  if (await confirmar('¿Descubro el chat id solo? (mandás un mensaje al bot y lo leo)')) {
    const d = await descubrirChat(token);
    if (d) {
      console.log(`Encontré el chat: «${d.nombre}» (id ${d.id})`);
      if (await confirmar('¿Es este el chat al que hay que avisar?')) {
        chatId = d.id;
      }
    } else {
      console.log('No apareció ningún mensaje (pasa con grupos y canales).');
    }
  }
  if (!chatId) {
    chatId = await preguntar('Pegá el chat id a mano (o Enter para cancelar): ');
  }
  if (!chatId) {
    console.log('Sin chat id no se puede terminar. Chau.');
    return;
  }

  // 5. Guardar.
  await setValor('ads_telegram_bot_token', token);
  await setValor('ads_telegram_chat_id', chatId);
  await setValor('ads_telegram_enabled', true);
  console.log(`\nGuardado. Token ${enmascararToken(token)} · chat ${chatId} · habilitado.\n`);

  // 6. Prueba: no termina hasta confirmar la entrega.
  for (;;) {
    const r = await avisar({ texto: 'Panel · reglas: mensaje de prueba de Telegram. ¡Llegó!', urgente: false });
    if (r.enviado) {
      console.log('Mensaje de prueba enviado.');
    } else {
      console.log(`No se pudo enviar: ${r.error ?? 'sin error (¿deshabilitado?)'}`);
    }
    if (await confirmar('¿Te llegó el mensaje al teléfono?')) break;
    console.log('Reintento de envío...\n');
  }
  console.log('Listo. Los avisos del motor saldrán por acá.');
}

async function testExistente(): Promise<void> {
  const r = await avisar({ texto: 'Panel · reglas: mensaje de prueba (--test).', urgente: false });
  if (r.enviado) {
    console.log('Mensaje de prueba enviado.');
  } else {
    console.log(`No se pudo enviar: ${r.error ?? 'telegram deshabilitado o sin configurar'}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--test')) {
    await testExistente();
    return;
  }
  await flujoCompleto();
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('telegram-setup falló:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
