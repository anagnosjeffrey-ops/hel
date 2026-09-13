import { createPool, migrate } from '../store/postgres/pool.js';
import { createPostgresStores } from '../store/postgres/stores.js';
import { generateApiKey, hashApiKey } from '../http/auth.js';
import type { PlanId } from '../domain/subscription.js';
import type { Dealer } from '../domain/dealer.js';

/**
 * Onboard a rooftop and mint its API key.
 *
 * The key is printed once and stored only as a digest — there is no way to
 * recover it afterward, only to issue a new one. Verification of the dealer
 * licence and floor plan happens outside this command; `--verified` records
 * that someone did it.
 */
function usage(): never {
  console.error(
    [
      'Usage: register-dealer --id <id> --name <name> [options]',
      '',
      '  --id         Rooftop identifier, e.g. gilroy-toyota',
      '  --name       Display name',
      '  --plan       starter | dealer | group   (default: dealer)',
      '  --verified   Mark licence and floor plan as cleared',
      '  --rooftops   Number of rooftops (default: 1)',
    ].join('\n'),
  );
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const VALID_PLANS: readonly PlanId[] = ['starter', 'dealer', 'group'];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const id = typeof args['id'] === 'string' ? args['id'] : null;
  const name = typeof args['name'] === 'string' ? args['name'] : null;
  if (id === null || name === null) usage();

  const plan = typeof args['plan'] === 'string' ? args['plan'] : 'dealer';
  if (!VALID_PLANS.includes(plan as PlanId)) {
    console.error(`Unknown plan "${plan}". Choose one of: ${VALID_PLANS.join(', ')}`);
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('DATABASE_URL must be set.');
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
    const stores = createPostgresStores(pool);

    const dealer: Dealer = {
      id,
      name,
      rooftopCount: Number(args['rooftops'] ?? 1),
      subscription: { planId: plan as PlanId, status: 'trialing' },
      verified: args['verified'] === true,
      bidLimit: null,
    };

    const apiKey = generateApiKey();
    await stores.dealers.upsert(dealer, hashApiKey(apiKey));

    console.log(`Registered ${dealer.name} (${dealer.id}) on the ${plan} plan.`);
    console.log(`Verified: ${dealer.verified ? 'yes' : 'no — cannot buy or sell until verified'}`);
    console.log('');
    console.log(`  API key: ${apiKey}`);
    console.log('');
    console.log('This key is shown once. Store it now; only its digest is kept.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
