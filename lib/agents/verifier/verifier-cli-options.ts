export type VerifierCliOptions = {
  hours: number;
  limit: number;
};

function positiveInteger(name: string, value: string | undefined, maximum: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseVerifierCliOptions(
  argv: readonly string[],
  environment: Record<string, string | undefined> = process.env
): VerifierCliOptions {
  const valueFor = (name: string): string | undefined => {
    const argument = argv.find((value) => value.startsWith(`--${name}=`));
    return argument?.slice(name.length + 3) ?? environment[`npm_config_${name}`];
  };

  return {
    hours: positiveInteger("hours", valueFor("hours"), 168) ?? 24,
    limit: positiveInteger("limit", valueFor("limit"), 100) ?? 10,
  };
}
