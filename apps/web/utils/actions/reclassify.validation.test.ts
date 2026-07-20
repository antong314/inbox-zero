import { describe, expect, it } from "vitest";
import { reclassifyMessagesBody } from "./reclassify.validation";

describe("reclassifyMessagesBody", () => {
  it("rejects duplicate messages that could race during bulk correction", () => {
    const result = reclassifyMessagesBody.safeParse({
      targetRuleId: "newsletter-rule",
      messages: [{ messageId: "message-1" }, { messageId: "message-1" }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts up to 100 unique messages", () => {
    const result = reclassifyMessagesBody.safeParse({
      targetRuleId: "newsletter-rule",
      messages: Array.from({ length: 100 }, (_, index) => ({
        messageId: `message-${index}`,
      })),
    });

    expect(result.success).toBe(true);
  });
});
