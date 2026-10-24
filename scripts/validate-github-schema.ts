import { buildSchema, parse, validate } from "graphql";
import { HEAD_QUERY, QUERY } from "../src/github.ts";

// Public schema only. No GitHub credentials, repository reads, or mutations.
const response = await fetch(
  "https://docs.github.com/public/fpt/schema.docs.graphql",
  {
    signal: AbortSignal.timeout(30_000),
  },
);
if (!response.ok) throw new Error(`Schema download failed: ${response.status}`);
const schema = buildSchema(await response.text());
for (const [name, query] of [
  ["snapshot", QUERY],
  ["head", HEAD_QUERY],
]) {
  if (!name || !query) throw new Error("Missing query");
  const errors = validate(schema, parse(query));
  if (errors.length)
    throw new Error(`${name}: ${errors.map((e) => e.message).join("; ")}`);
  console.log(`GitHub public GraphQL schema: ${name} query valid`);
}
