import { contractSchemas } from "../lib/agents/contracts/index.ts";
import { invalidFixtures, validFixtures } from "../lib/agents/contracts/fixtures.ts";

let failures = 0;

for (const [name, schema] of Object.entries(contractSchemas)) {
  const validResult = schema.safeParse(validFixtures[name]);
  if (!validResult.success) {
    failures += 1;
    console.error(`FAIL valid ${name}:`, validResult.error.issues);
  } else {
    console.log(`PASS valid ${name}`);
  }

  const invalidResult = schema.safeParse(invalidFixtures[name]);
  if (invalidResult.success) {
    failures += 1;
    console.error(`FAIL invalid ${name}: fixture was accepted`);
  } else {
    console.log(`PASS invalid ${name}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} contract expectation(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${Object.keys(contractSchemas).length} contract fixtures passed.`);
}
