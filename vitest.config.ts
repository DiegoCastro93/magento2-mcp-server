import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        // Fixture mode is the default, but make it explicit so a stray .env on a
        // developer machine cannot point the suite at a real Magento instance.
        env: {
            MAGENTO_MODE: 'fixture'
        }
    }
});
