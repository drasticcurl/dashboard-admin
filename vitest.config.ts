import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Sin jsdom ni testing-library: este proyecto testea funciones puras y SQL,
 * no componentes. Los tests que necesitan la base se saltan con skipIf cuando
 * no hay DATABASE_URL, así que la suite corre también sin Postgres.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Los tests de integración corren contra las MISMAS tablas: en paralelo se
    // pisan y aparecen timeouts flaky. Serializar archivos los estabiliza.
    fileParallelism: false,
  },
});
