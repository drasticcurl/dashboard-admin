/**
 * El protocolo MCP del panel (JSON-RPC 2.0 sobre Streamable HTTP, sin estado) —
 * PURO: no sabe de base ni de Meta, recibe las herramientas por parámetro.
 *
 * Se implementa a mano y no con el SDK porque el servidor es mínimo: sin
 * sesiones, sin SSE, sin recursos ni prompts. Sólo `initialize`, `ping`,
 * `tools/list` y `tools/call`, y cada POST se contesta con un JSON. Es lo que la
 * spec llama "stateless" y lo que aceptan Claude Code, Claude.ai y los demás
 * clientes de Streamable HTTP.
 *
 * Un error DENTRO de una herramienta (fecha inválida, funnel que no existe) no
 * es un error de protocolo: vuelve como resultado con `isError: true`, para que
 * la IA lo lea y corrija el pedido.
 */

export const VERSIONES_SOPORTADAS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type Herramienta = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Devuelve lo que la IA va a leer (se serializa a JSON). Tira = isError. */
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type MensajeRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type RespuestaRpc =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/**
 * Un error que la herramienta tira a propósito, con un mensaje para la IA. Se
 * reconoce por `name` y no por `instanceof`: si el módulo se carga dos veces
 * (pasó con tsx y dos especificadores distintos) las clases no son la misma y
 * el mensaje se perdía detrás de "error interno".
 */
export class ErrorHerramienta extends Error {
  override name = 'ErrorHerramienta';
}

const esErrorHerramienta = (e: unknown): e is ErrorHerramienta =>
  e instanceof Error && e.name === 'ErrorHerramienta';

const INSTRUCCIONES =
  'Datos de los anuncios de Meta del panel, SÓLO LECTURA: nada de esto pausa, ' +
  'edita ni cambia presupuestos. Flujo típico: `listar_funnels` → `anuncios` ' +
  '(un funnel y un rango de fechas; sólo trae anuncios con gasto o ventas) → ' +
  'elegir los ganadores con tu propio criterio → `links_creativos` con sus ad_id ' +
  'para bajar el video o la imagen. Las ventas son reales (órdenes atribuidas por ' +
  'los UTMs), en EUR. ROI = neto ÷ gasto: 1,0 es empatar; el dueño escala desde 1,85.';

/**
 * Procesa UN mensaje. null = era una notificación (sin id): no lleva respuesta.
 */
export async function procesar(m: MensajeRpc, herramientas: Herramienta[]): Promise<RespuestaRpc | null> {
  const id = m.id ?? null;
  const esNotificacion = m.id === undefined;
  const ok = (result: unknown): RespuestaRpc => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string): RespuestaRpc => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    return esNotificacion ? null : err(-32600, 'pedido JSON-RPC inválido');
  }
  if (esNotificacion) return null;

  switch (m.method) {
    case 'initialize': {
      const pedida = String(m.params?.protocolVersion ?? '');
      const version = (VERSIONES_SOPORTADAS as readonly string[]).includes(pedida) ? pedida : VERSIONES_SOPORTADAS[0];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'panel-anuncios', version: '1.0.0' },
        instructions: INSTRUCCIONES,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: herramientas.map((h) => ({
          name: h.name,
          description: h.description,
          inputSchema: h.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const nombre = m.params?.name;
      const h = herramientas.find((x) => x.name === nombre);
      if (!h) return err(-32602, `herramienta desconocida: ${String(nombre)}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const salida = await h.run(args);
        return ok({ content: [{ type: 'text', text: JSON.stringify(salida) }] });
      } catch (e) {
        // Un error inesperado no expone detalles internos (SQL, stack): sólo los
        // ErrorHerramienta llevan su mensaje, que está escrito para la IA.
        const texto = esErrorHerramienta(e) ? e.message : 'error interno del panel; probá de nuevo';
        if (!esErrorHerramienta(e)) console.error(`[mcp] ${h.name} falló:`, e);
        return ok({ content: [{ type: 'text', text: texto }], isError: true });
      }
    }
    default:
      return err(-32601, `método no soportado: ${m.method}`);
  }
}
