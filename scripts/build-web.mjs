import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../public/', import.meta.url);
const output = new URL('../www/', import.meta.url);
const capacitorRuntime = new URL('../node_modules/@capacitor/core/dist/capacitor.js', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await cp(capacitorRuntime, new URL('./capacitor.js', output));
console.log(`Copied web assets for Capacitor from ${root}`);
