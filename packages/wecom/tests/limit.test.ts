import { describe, expect, it } from "vitest";
import { Budget, CONVERSATION } from "../src/limit.js";

describe("budget", () => {
  it("allows 30 a minute and says how long until the next", () => {
    let t = 0;
    const budget = new Budget(CONVERSATION, () => t);
    for (let i = 0; i < 30; i++) { expect(budget.wait("chat")).toBe(0); budget.take("chat"); t += 1000; }
    expect(budget.wait("chat")).toBe(30_000);
    expect(budget.wait("other")).toBe(0);
    t += 30_000;
    expect(budget.wait("chat")).toBe(0);
  });

  it("keeps the reserve for what must not wait", () => {
    const budget = new Budget(CONVERSATION, () => 0);
    budget.take("chat", 25);
    expect(budget.wait("chat", 1, true)).toBe(60_000);
    expect(budget.wait("chat")).toBe(0);
    expect(budget.wait("chat", 6)).toBe(60_000);
  });

  it("allows 1000 an hour even at 30 a minute", () => {
    let t = 0;
    const budget = new Budget(CONVERSATION, () => t);
    for (let i = 0; i < 1000; i++) { expect(budget.wait("chat")).toBe(0); budget.take("chat"); t += 2000; }
    expect(budget.wait("chat")).toBe(1_600_000);
    t += 1_600_000;
    expect(budget.wait("chat")).toBe(0);
  });
});
