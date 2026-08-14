/**
 * output: 'standalone' es obligatorio para el deploy (D17): la app corre en
 * PM2 + Next standalone + Caddy en la VPS, igual que los funnels. Sin el build
 * autocontenido, PM2 tendría que arrancar `next start` con node_modules
 * completo.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Sin esto Next manda "X-Powered-By: Next.js" en todas las respuestas; el
  // panel es un subdominio público con datos de ventas y no tiene por qué
  // anunciar su stack (D16).
  poweredByHeader: false,
};

export default nextConfig;
