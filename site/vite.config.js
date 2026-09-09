import { defineConfig } from 'vite';

// Relative base so the built site works from a project page, a subpath, or
// straight off the filesystem without a rebuild.
export default defineConfig({ base: './' });
