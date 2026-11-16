import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schedulerKickoffMetadata } from "../lib/agents/pipeline/scheduler/scheduler-control-policy.ts";
import type { SupervisedSchedulerInvocationResult } from "../lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts";

type Invocation = (input: { metadata: unknown; executionSource: "github_actions"; now: Date }) => Promise<SupervisedSchedulerInvocationResult>;

export async function runScheduledInvocationCli(options: {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  invoke?: Invocation;
  write?: (line: string) => void;
} = {}): Promise<number> {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const write = options.write ?? console.log;
  if (args.length !== 1 || args[0] !== "--execute-supervised") {
    write("Refusing scheduled execution: pass --execute-supervised explicitly");
    return 2;
  }
  if (env.SCHEDULER_WORKER_ENABLED !== "true") {
    write("Refusing scheduled execution: SCHEDULER_WORKER_ENABLED must be true");
    return 2;
  }

  const now = (options.now ?? (() => new Date()))();
  const metadata = schedulerKickoffMetadata(now);
  const invoke = options.invoke ?? (await import("../lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts")).runSupervisedScheduledInvocation;
  const result = await invoke({ metadata, executionSource: "github_actions", now });
  write(JSON.stringify({ ...result, utcDate: metadata.utcDate, triggerId: metadata.triggerId, invocationId: metadata.invocationId }, null, 2));
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  runScheduledInvocationCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "SCHEDULED_INVOCATION_FAILED");
    process.exitCode = 1;
  });
}
