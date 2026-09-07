/**
 * Exits 0 when the API reports healthy, 1 otherwise. Used by the Docker
 * HEALTHCHECK and safe to point an external uptime monitor at.
 *
 *   npx tsx scripts/healthcheck.ts [url]
 */
const target =
  process.argv[2]
  || process.env.HEALTHCHECK_URL
  || `http://127.0.0.1:${process.env.PORT || '3000'}/api/health/live`;

async function main(): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(target, { signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      console.error(`unhealthy: HTTP ${res.status} from ${target}\n${body.slice(0, 400)}`);
      return 1;
    }
    console.log(`healthy: ${target} -> ${res.status}`);
    return 0;
  } catch (error) {
    console.error(`unreachable: ${target} (${(error as Error).message})`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

main().then((code) => { process.exit(code); });
