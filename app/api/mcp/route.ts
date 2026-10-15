/**
 * /api/mcp — servidor MCP de los anuncios, SÓLO LECTURA (ver lib/mcp/).
 *
 * Para que una IA (Claude Code, Claude.ai, etc.) consulte los anuncios de cada
 * funnel en un rango y baje los creativos. Streamable HTTP sin estado: cada POST
 * es un mensaje JSON-RPC y se contesta con un JSON. No hay GET (sin SSE).
 *
 * Como el widget: fuera del matcher del middleware ('publica' en MAPA_API) y con
 * token propio, `MCP_TOKEN`, en `Authorization: Bearer …`. Sin `MCP_TOKEN` el
 * endpoint no existe (404). Rotarlo corta a todos los clientes configurados.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { HERRAMIENTAS } from '@/lib/mcp/herramientas';
import { procesar, type MensajeRpc } from '@/lib/mcp/protocolo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// `anuncios` de 90 días con varias cuentas, o 20 creativos, puede tardar.
export const maxDuration = 120;

const SIN_CACHE = { 'Cache-Control': 'no-store' };

function tokenValido(recibido: string, esperado: string): boolean {
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

function autorizar(req: NextRequest): NextResponse | null {
  const esperado = process.env.MCP_TOKEN?.trim();
  if (!esperado) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const auth = req.headers.get('authorization') ?? '';
  const recibido = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!recibido || !tokenValido(recibido, esperado)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: SIN_CACHE });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const denegado = autorizar(req);
  if (denegado) return denegado;

  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } },
      { status: 400, headers: SIN_CACHE },
    );
  }

  const mensajes = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]) as MensajeRpc[];
  const respuestas = (await Promise.all(mensajes.map((m) => procesar(m, HERRAMIENTAS)))).filter((r) => r !== null);

  // Sólo notificaciones: 202 sin cuerpo (lo que pide la spec).
  if (respuestas.length === 0) return new NextResponse(null, { status: 202, headers: SIN_CACHE });
  return NextResponse.json(Array.isArray(cuerpo) ? respuestas : respuestas[0], { headers: SIN_CACHE });
}

export async function GET(req: NextRequest) {
  const denegado = autorizar(req);
  if (denegado) return denegado;
  return new NextResponse(null, { status: 405, headers: { ...SIN_CACHE, Allow: 'POST' } });
}

export async function DELETE(req: NextRequest) {
  const denegado = autorizar(req);
  if (denegado) return denegado;
  return new NextResponse(null, { status: 405, headers: { ...SIN_CACHE, Allow: 'POST' } });
}
