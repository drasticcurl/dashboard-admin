/**
 * Verificación de la cookie de sesión con identidad, del hash de contraseñas y de
 * la aritmética del ROI.
 *
 *   node tasks/usuarios-y-tareas/_verificacion-sesion.mjs
 *
 * Esperado: las 16 afirmaciones dicen PASA y el proceso sale con 0.
 * No toca la base, no toca la red, no escribe nada.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE. El formato del token se verifica en DOS runtimes
 * distintos con DOS primitivas distintas: `node:crypto` en el server
 * (`lib/auth.ts`) y `crypto.subtle` en Edge (`middleware.ts`, que no puede
 * importar el otro y lo dice en su docblock). Si las dos no producen el mismo
 * hex, el panel deja entrar por el middleware y rebota en el layout —
 * un bucle de redirects que no se ve en ningún test unitario de un solo lado.
 *
 * YA CORRIDO EN VERDE con Node v24.14.0 el 2026-09-08.
 */

import crypto from 'node:crypto';

let fallas = 0;
function afirmar(cond, chequeo, real = '') {
  if (cond) console.log(`PASA   ${chequeo}${real ? `  → ${real}` : ''}`);
  else { console.log(`FALLA  ${chequeo}${real ? `  → ${real}` : ''}`); fallas++; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. El hash de contraseñas: scrypt de node:crypto, sin dependencias nuevas
// ═══════════════════════════════════════════════════════════════════════════

const N = 16384, r = 8, p = 1, KEYLEN = 32;

/** El formato que guarda `usuarios.clave_hash`. Los parámetros van EN la fila. */
function hashear(clave, salt = crypto.randomBytes(16)) {
  const dk = crypto.scryptSync(clave, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verificar(clave, guardado) {
  const partes = guardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, rr, pp, saltHex, dkHex] = partes;
  const dk = crypto.scryptSync(clave, Buffer.from(saltHex, 'hex'), dkHex.length / 2, {
    N: Number(n), r: Number(rr), p: Number(pp),
  });
  const esperado = Buffer.from(dkHex, 'hex');
  return dk.length === esperado.length && crypto.timingSafeEqual(dk, esperado);
}

const guardado = hashear('una-clave-de-quince-o-mas');
afirmar(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(guardado),
  ' 1. el hash tiene la forma que exige el CHECK de la 030', guardado.slice(0, 34) + '…');
afirmar(verificar('una-clave-de-quince-o-mas', guardado), ' 2. la clave correcta verifica');
afirmar(!verificar('otra-clave-cualquiera-xx', guardado), ' 3. una clave incorrecta NO verifica');
afirmar(!verificar('', guardado), ' 4. clave vacía NO verifica');

// Los parámetros salen de la FILA, no de una constante: es lo que permite subir el
// costo más adelante sin invalidar los hashes viejos.
const viejo = `scrypt$1024$8$1$${'a'.repeat(32)}$${crypto
  .scryptSync('clave-con-parametros-viejos', Buffer.from('a'.repeat(32), 'hex'), 32, { N: 1024, r: 8, p: 1 })
  .toString('hex')}`;
afirmar(verificar('clave-con-parametros-viejos', viejo),
  ' 5. un hash con N viejo (1024) sigue verificando: los parámetros salen de la fila');

const t0 = process.hrtime.bigint();
verificar('una-clave-de-quince-o-mas', guardado);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
// El login prueba UN hash (busca por usuario). Con el rate limit de 5 intentos /
// 15 min por IP que ya existe en lib/auth.ts:214-267, esto no es una superficie
// de DoS. Se afirma la banda, no un número exacto: depende de la máquina.
afirmar(ms > 20 && ms < 400, ' 6. verificar cuesta entre 20 y 400 ms (costo real de scrypt)',
  `${ms.toFixed(0)} ms`);

// ═══════════════════════════════════════════════════════════════════════════
// 2. El token: `${usuarioId}.${ts}.${sig}` — el MISMO hex en Node y en Edge
// ═══════════════════════════════════════════════════════════════════════════

const SECRETO = 'un-secreto-de-firma-independiente-de-las-claves';

function firmarNode(usuarioId, ts) {
  const payload = `${usuarioId}.${ts}`;
  return `${payload}.${crypto.createHmac('sha256', SECRETO).update(payload).digest('hex')}`;
}

async function firmarEdge(usuarioId, ts) {
  const payload = `${usuarioId}.${ts}`;
  const key = await crypto.webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRETO), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${payload}.${hex}`;
}

const AHORA = 1757318400000;
const tokenNode = firmarNode(7, AHORA);
const tokenEdge = await firmarEdge(7, AHORA);
afirmar(tokenNode === tokenEdge,
  ' 7. node:crypto y crypto.subtle firman IGUAL (el middleware Edge puede verificar)',
  tokenNode.slice(0, 30) + '…');

/** El parser del token nuevo. Rechaza todo lo que no sean 3 campos enteros. */
function parsear(token) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [idStr, tsStr, sig] = partes;
  // `/^\d+$/` y no `Number()`: Number('7e2') es 700 y Number(' 7') es 7, así que
  // dos strings distintos darían el mismo id con firmas distintas.
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(tsStr)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  return { usuarioId: Number(idStr), ts: Number(tsStr) };
}

afirmar(parsear(tokenNode)?.usuarioId === 7 && parsear(tokenNode)?.ts === AHORA,
  ' 8. el parser saca el usuarioId y el ts del token nuevo');

// El token VIEJO tiene 2 campos (`ts.sig`). Tiene que ser rechazado, no
// malinterpretado: si el parser lo aceptara leyendo el ts como id, cualquiera con
// una cookie vieja entraría como el usuario cuyo id coincida con un timestamp.
const tokenViejo = `${AHORA}.${crypto.createHmac('sha256', SECRETO).update(String(AHORA)).digest('hex')}`;
afirmar(parsear(tokenViejo) === null,
  ' 9. el token VIEJO de 2 campos se rechaza (todas las sesiones vivas se cortan en el deploy)');

// La ambigüedad que hay que descartar a mano: si el payload firmado fuera la
// concatenación sin separador, id=1/ts=23 y id=12/ts=3 darían la misma firma. Con
// el punto adentro del payload, "1.23" y "12.3" son strings distintos.
afirmar(firmarNode(1, 23) !== firmarNode(12, 3),
  '10. id=1,ts=23 y id=12,ts=3 firman distinto (el punto va DENTRO del payload)');

// Manipular el id invalida la firma: es lo único que impide entrar como otro
// editando la cookie a mano.
const manipulado = `9.${AHORA}.${tokenNode.split('.')[2]}`;
const esperadoManipulado = crypto.createHmac('sha256', SECRETO).update(`9.${AHORA}`).digest('hex');
afirmar(manipulado.split('.')[2] !== esperadoManipulado,
  '11. cambiarle el id a la cookie invalida la firma');

afirmar(parsear('abc.def.ghi') === null && parsear(`7.${AHORA}`) === null && parsear('') === null,
  '12. basura, 2 campos y string vacío → null');

// ═══════════════════════════════════════════════════════════════════════════
// 3. El ROI del Resumen
// ═══════════════════════════════════════════════════════════════════════════
//
// `lib/queries/overview.ts:438` ya expone `roas = brutoTotal / adSpend`, con el
// BRUTO (antes de devoluciones, comisiones y costos) y devolviendo 0 sin gasto.
//
// El ROI que se agrega usa el NETO: `netEur / adSpendEur`. Se lee como múltiplo y
// el punto de equilibrio es 1.00×, que es lo que hace que 1.25× signifique algo de
// un vistazo. Se descartó `resultEur / adSpendEur` (que también es "retorno sobre
// la inversión") porque su equilibrio cae en 0.00× y un múltiplo cuyo cero es el
// break-even no se lee; además la ganancia en plata ya la dice el widget de
// Resultado. La relación entre las dos lecturas se afirma abajo para que el
// comentario del código no tenga que mentir.
//
// null y no 0 sin denominador: es la regla que `overview.ts:58-62` fija para
// TODOS los campos nuevos ("no se puede calcular" y "vale cero" son cosas
// distintas). Los viejos devuelven 0 por compatibilidad y no se unifican.

const roi = (netEur, adSpendEur) => (adSpendEur > 0 ? netEur / adSpendEur : null);

afirmar(roi(1250, 1000) === 1.25, '13. neto 1250 / gasto 1000 → 1.25×', String(roi(1250, 1000)));
afirmar(roi(1000, 1000) === 1 && roi(800, 1000) === 0.8,
  '14. el equilibrio es 1.00× y por debajo se pierde plata');
afirmar(roi(1250, 0) === null && roi(0, 0) === null,
  '15. sin gasto cargado → null, nunca Infinity ni NaN', String(roi(1250, 0)));
// resultEur = netEur - adSpendEur (overview.ts:388). Entonces roi = 1 + result/gasto.
const netEur = 1250, gasto = 1000, resultEur = netEur - gasto;
afirmar(Math.abs(roi(netEur, gasto) - (1 + resultEur / gasto)) < 1e-12,
  '16. roi === 1 + resultEur/gasto (coherente con el widget de Resultado)');

console.log('');
console.log(fallas === 0 ? 'TODO EN VERDE' : `${fallas} AFIRMACIONES EN FALLA`);
process.exit(fallas === 0 ? 0 : 1);
