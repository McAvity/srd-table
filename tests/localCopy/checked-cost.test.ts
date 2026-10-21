import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateLocalCopy } from "@/import/localCopy/format";
import { contentSha } from "@/lib/canonical";

// Synthetic historical JSON; actual engine/state integration is exercised by the Kenli7 smoke.
const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/long-pinned.local-copy.fixture"),
  "utf8",
);
const reason = {
  code: "resource_empty",
  category: "resource",
  text: "No slot",
  message: { code: "resource_empty", params: {}, text: "No slot" },
};
async function check(cost: unknown) {
  const copy = JSON.parse(fixture);
  copy.payload.history.entries[0].costs = [cost];
  copy.payload_sha256 = await contentSha(copy.payload);
  return validateLocalCopy(new TextEncoder().encode(JSON.stringify(copy)), { engine: false });
}
const kinds = [
  { type: "play", action: { type: "spend_slot", level: 1 } },
  { type: "daily", key: "test", per_day: 1, name: "Test" },
  { type: "recharge", name: "Test" },
];
describe("D-01: recorded CheckedCost is preserved by local-copy validation", () => {
  for (const cost of kinds) {
    it(`${cost.type}: plain, payable and refused costs retain their literal metadata`, async () => {
      for (const metadata of [{}, { payable: true, reason: null }, { payable: false, reason }]) {
        const value = { ...cost, ...metadata };
        const result = await check(value);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.copy.payload.history.entries[0]?.costs).toEqual([value]);
      }
    });
  }
  it("still refuses invalid types, malformed reasons and unknown fields", async () => {
    for (const metadata of [
      { payable: "yes" },
      { reason: false },
      { reason: { ...reason, message: null } },
      { reason: { ...reason, category: 1 } },
      { extra: true },
    ]) {
      const result = await check({ ...kinds[0], ...metadata });
      expect(result.ok).toBe(false);
    }
  });
});
