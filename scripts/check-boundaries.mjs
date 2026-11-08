import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
    f.isDirectory() ? walk(join(dir, f.name)) : [join(dir, f.name)],
  );
}
for (const file of [...walk('apps/mobile/src'), ...walk('apps/mobile/app')]) {
  const text = readFileSync(file, 'utf8');
  if (
    /(?:from|import\()\s*['"][^'"]*(?:gateway|adapter-sdk|node:|better-sqlite3|drizzle|@google|services\/gateway)/.test(
      text,
    )
  )
    throw new Error(`Backend dependency in ${file}`);
}
console.log('Mobile/backend dependency boundary passed');
