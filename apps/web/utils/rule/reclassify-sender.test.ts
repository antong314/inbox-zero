import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { GroupItemSource } from "@/generated/prisma/enums";
import { saveLearnedPattern } from "@/utils/rule/learned-patterns";
import { setSenderClassification } from "./reclassify-sender";

vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPattern: vi.fn(),
}));

describe("setSenderClassification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes the sender in the target rule and excludes it from competing rules", async () => {
    await setSenderClassification({
      emailAccountId: "account-id",
      sender: "Sender@Example.com",
      targetRuleId: "newsletter-rule",
      classificationRuleIds: [
        "newsletter-rule",
        "marketing-rule",
        "notification-rule",
      ],
      logger: createTestLogger(),
    });

    expect(saveLearnedPattern).toHaveBeenCalledTimes(3);
    expect(saveLearnedPattern).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        ruleId: "newsletter-rule",
        exclude: false,
        source: GroupItemSource.USER,
      }),
    );
    expect(saveLearnedPattern).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        ruleId: "marketing-rule",
        exclude: true,
        source: GroupItemSource.USER,
      }),
    );
    expect(saveLearnedPattern).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        ruleId: "notification-rule",
        exclude: true,
        source: GroupItemSource.USER,
      }),
    );
    expect(vi.mocked(saveLearnedPattern).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        ruleId: "newsletter-rule",
        exclude: false,
      }),
    );
  });

  it("rejects a target outside the classification rule set", async () => {
    await expect(
      setSenderClassification({
        emailAccountId: "account-id",
        sender: "sender@example.com",
        targetRuleId: "custom-rule",
        classificationRuleIds: ["newsletter-rule"],
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("Target classification rule not found");

    expect(saveLearnedPattern).not.toHaveBeenCalled();
  });
});
