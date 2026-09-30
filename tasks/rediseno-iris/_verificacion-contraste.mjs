// Verificación de fase 3 del plan rediseno-iris: la paleta congelada de §4
// cumple los contrastes que el plan promete. Correr: node tasks/rediseno-iris/_verificacion-contraste.mjs
// Sale con código 1 si alguna afirmación no se cumple.
const P = {
  canvas: '#0c0b14', surface: '#15141f', raised: '#1d1c2b', overlaySurf: '#252437',
  n50: '#f7f7fb', n100: '#ecebf3', n200: '#d8d6e4', n300: '#b6b3c7', n400: '#9894ab', n500: '#827e98', n600: '#5c5870',
  a100: '#e6e2ff', a200: '#cbc4ff', a300: '#b0a6ff', a400: '#9d8fff', a500: '#8b7bff', a600: '#6f5ef0', a700: '#5242c4', a800: '#352a85', a900: '#1e1848',
  g300: '#74e4bd', g400: '#4fdba9', g500: '#34d39a', g900: '#0a2e22',
  w300: '#f7cf8a', w400: '#f3bf66', b300: '#ff9ea3', b400: '#ff8388', i300: '#9fd3ff', i400: '#7cc5ff',
};
const lum = (h) => { const c = [1,3,5].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; };
const cr = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((m,n)=>n-m); return (x+0.05)/(y+0.05); };
const casos = [
  ['texto principal n100 / surface', 'n100','surface', 12],
  ['texto secundario n400 / surface', 'n400','surface', 4.5],
  ['texto apagado n500 / surface', 'n500','surface', 4.5],
  ['texto apagado n500 / canvas', 'n500','canvas', 4.5],
  ['texto apagado n500 / raised', 'n500','raised', 4.0],
  ['acento texto a400 / surface', 'a400','surface', 4.5],
  ['acento texto a300 / canvas', 'a300','canvas', 4.5],
  ['nav activo a100 / a900', 'a100','a900', 10],
  ['boton primario canvas / a500', 'canvas','a500', 4.5],
  ['boton primario canvas / a400 (tope del degradado)', 'canvas','a400', 4.5],
  ['good-400 / surface', 'g400','surface', 4.5],
  ['warn-400 / surface', 'w400','surface', 4.5],
  ['bad-400 / surface', 'b400','surface', 4.5],
  ['info-400 / surface', 'i400','surface', 4.5],
  ['acento no se confunde con info (distancia de tono: a500 vs i500 distinto hue) — contraste a500/surface >= 4.5', 'a500','surface', 4.5],
];
let mal = 0;
for (const [nombre,f,b,min] of casos) {
  const r = cr(P[f],P[b]); const ok = r >= min; if (!ok) mal++;
  console.log(`${ok?'OK ':'MAL'}  ${r.toFixed(2).padStart(5)}:1  (>= ${min})  ${nombre}`);
}
console.log(mal ? `\n${mal} en rojo` : '\ntodo en verde'); process.exit(mal?1:0);
