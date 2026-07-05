/**
 * CLI for API key management.
 *
 *   node dist/keys/cli.js create --label=acme --rpm=60 [--expires-in=30d]
 *   node dist/keys/cli.js list
 *   node dist/keys/cli.js revoke <id>
 *   node dist/keys/cli.js remove <id>
 *
 * `revoke` soft-disables a key (verification fails, but it stays in the store
 * and `list`). `remove` hard-deletes the record from keys.json — irreversible.
 *
 * Uses the same config as the server (KEYS_FILE via env). Exit codes: 0 on
 * success, 1 on usage error, 2 on not-found.
 */
import { KeyStore } from './store.js';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  cli create --label=<text> [--rpm=<n>] [--expires-in=<Nd|Nh|Nm>]',
      '  cli list',
      '  cli revoke <id>',
      '  cli remove <id>   # hard-delete (irreversible)',
    ].join('\n'),
  );
  process.exit(1);
}

function parseExpiresIn(raw: string): number {
  const m = /^(\d+)([dhm])$/.exec(raw);
  if (!m) usage();
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 86_400_000;
    case 'h':
      return n * 3_600_000;
    case 'm':
      return n * 60_000;
    default:
      usage();
  }
}

function fileFromEnv(): string {
  return process.env.KEYS_FILE || './data/keys.json';
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) usage();
  const store = new KeyStore(fileFromEnv());

  if (cmd === 'create') {
    let label = '';
    let rpm: number | null = null;
    let expiresIn: number | null = null;
    for (const arg of rest) {
      if (arg.startsWith('--label=')) label = arg.slice(8);
      else if (arg.startsWith('--rpm=')) rpm = Number(arg.slice(6)) || null;
      else if (arg.startsWith('--expires-in=')) expiresIn = parseExpiresIn(arg.slice(13));
      else usage();
    }
    if (!label) usage();

    const { record, plaintext } = await store.create({
      label,
      rpm,
      expiresAt: expiresIn ? Date.now() + expiresIn : null,
    });

    console.log('Key created. Store this plaintext now — it will not be shown again:');
    console.log(plaintext);
    console.log('');
    console.log('  id:        ' + record.id);
    console.log('  label:     ' + record.label);
    console.log('  rpm:       ' + (record.rpm ?? '(default)'));
    console.log('  expiresAt: ' + (record.expiresAt ? new Date(record.expiresAt).toISOString() : '(never)'));
    console.log('  created:   ' + new Date(record.createdAt).toISOString());
    return;
  }

  if (cmd === 'list') {
    const keys = await store.list();
    if (keys.length === 0) {
      console.log('(no keys)');
      return;
    }
    for (const k of keys) {
      const status = k.revoked ? 'REVOKED' : 'active';
      const exp = k.expiresAt ? new Date(k.expiresAt).toISOString() : '-';
      console.log(
        `${k.id}\t${status}\trpm=${k.rpm ?? 'default'}\texp=${exp}\t${k.label}`,
      );
    }
    return;
  }

  if (cmd === 'revoke') {
    const id = rest[0];
    if (!id) usage();
    const rec = await store.revoke(id);
    if (!rec) {
      console.error(`No key with id "${id}"`);
      process.exit(2);
    }
    console.log(`Revoked ${rec.id} (${rec.label})`);
    return;
  }

  if (cmd === 'remove') {
    const id = rest[0];
    if (!id) usage();
    const rec = await store.remove(id);
    if (!rec) {
      console.error(`No key with id "${id}"`);
      process.exit(2);
    }
    console.log(`Removed ${rec.id} (${rec.label})`);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
