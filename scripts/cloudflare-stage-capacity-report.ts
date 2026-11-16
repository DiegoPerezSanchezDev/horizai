import { buildCloudflareStageCapacityReport } from "../lib/agents/runtime/cloudflare-stage-capacity.ts";

try {
  process.stdout.write(`${JSON.stringify(buildCloudflareStageCapacityReport(), null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Cloudflare capacity report failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
