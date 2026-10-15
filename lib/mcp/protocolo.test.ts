import { describe, expect, it } from 'vitest';
import { ErrorHerramienta, procesar, type Herramienta } from './protocolo';

const eco: Herramienta = {
  name: 'eco',
  description: 'devuelve lo que recibe',
  inputSchema: { type: 'object', properties: {} },
  run: async (args) => {
    if (args.romper === 'a_proposito') throw new ErrorHerramienta('fecha inválida');
    if (args.romper === 'bug') throw new Error('SELECT secreto falló');
    return { recibido: args };
  },
};

describe('procesar', () => {
  it('initialize negocia la versión y declara sólo tools', async () => {
    const r = await procesar(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      [eco],
    );
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    const otra = await procesar({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, []);
    expect(otra).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  it('las notificaciones no llevan respuesta', async () => {
    expect(await procesar({ jsonrpc: '2.0', method: 'notifications/initialized' }, [eco])).toBeNull();
  });

  it('tools/list marca todas las herramientas como sólo lectura', async () => {
    const r = await procesar({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, [eco]);
    expect(r).toMatchObject({
      result: { tools: [{ name: 'eco', annotations: { readOnlyHint: true, destructiveHint: false } }] },
    });
  });

  it('tools/call devuelve el resultado como texto JSON', async () => {
    const r = await procesar(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'eco', arguments: { a: 1 } } },
      [eco],
    );
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: '{"recibido":{"a":1}}' }] },
    });
  });

  it('un error de la herramienta vuelve como isError, y uno inesperado no filtra detalles', async () => {
    const a = await procesar(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'eco', arguments: { romper: 'a_proposito' } } },
      [eco],
    );
    expect(a).toMatchObject({ result: { isError: true, content: [{ text: 'fecha inválida' }] } });
    const b = await procesar(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'eco', arguments: { romper: 'bug' } } },
      [eco],
    );
    expect(JSON.stringify(b)).not.toContain('SELECT');
  });

  it('herramienta o método desconocidos son errores de protocolo', async () => {
    expect(
      await procesar({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pausar' } }, [eco]),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await procesar({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, [eco])).toMatchObject({
      error: { code: -32601 },
    });
  });
});
