/**
 * PM2 — un proceso Node, UNA sola instancia (task T12 §Parte B).
 *
 * Instalar/actualizar:
 *   pm2 start /srv/panel/repo/deploy/ecosystem.config.js
 *   pm2 save                 # persiste la lista para el reboot
 *   pm2 startup              # (una vez) genera el unit de systemd
 *
 * Una sola instancia y no dos, a diferencia de los funnels: el rate limit
 * del login es in-memory (lib/auth.ts) y con dos instancias el límite
 * efectivo se duplica. El panel tampoco necesita balanceo.
 *
 * Por qué `exec_mode: 'fork'` y no cluster: en cluster las instancias
 * comparten el MISMO puerto, y acá hay un solo proceso a propósito.
 *
 * `HOSTNAME: '127.0.0.1'` es obligatorio: el server.js del build standalone
 * bindea 0.0.0.0 por default. Sin esto el panel queda escuchando en todas
 * las interfaces y accesible salteando a Caddy. Es un panel con las ventas
 * de todos los funnels: que no pase.
 */

module.exports = {
  apps: [
    {
      name: 'panel-3005',
      script: 'server.js',
      cwd: '/srv/panel/current',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '3005',
        HOSTNAME: '127.0.0.1',
      },
      max_memory_restart: '600M',
      autorestart: true,
      // Las env vars de la app NO van acá: las lee Next desde el .env.production
      // que deploy.sh copia dentro de .next/standalone/.
      out_file: '/var/log/pm2/panel-3005.out.log',
      error_file: '/var/log/pm2/panel-3005.err.log',
      time: true,
    },
    {
      // El worker del motor de reglas (T18): evalúa cada minuto, con backoff
      // contra los límites de Meta y un lease en la base que impide que DOS
      // motores corran a la vez. Es un proceso aparte de la app a propósito
      // (D-A13): no se reinicia con el panel y no comparte su memoria.
      name: 'panel-reglas',
      // Mismo patrón que el cron: tsx NO lee .env solo, el flag de Node inyecta
      // las variables desde el .env.production que deploy.sh copió en current.
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-ad-rules.ts --daemon',
      interpreter: 'node',
      node_args: '--env-file=.env.production',
      cwd: '/srv/panel/current',
      exec_mode: 'fork',
      // NUNCA más de una instancia: con dos, los dos ticks se pelean por el
      // lease (scripts/run-ad-rules.ts §3) y uno de cada dos se descarta, o peor,
      // en la ventana de un pm2 reload dos motores duplican cada acción.
      instances: 1,
      autorestart: true,
      // Sin esto, un bug determinístico en el primer tick produce un ciclo de
      // reinicios que llena /var/log/pm2 en horas.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      max_memory_restart: '400M',
      out_file: '/var/log/pm2/panel-reglas.out.log',
      error_file: '/var/log/pm2/panel-reglas.err.log',
      time: true,
    },
  ],
};
