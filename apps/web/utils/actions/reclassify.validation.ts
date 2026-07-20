import { z } from "zod";

export const reclassifyMessagesBody = z
  .object({
    targetRuleId: z.string(),
    messages: z
      .array(
        z.object({
          messageId: z.string(),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine(({ messages }, ctx) => {
    const seenMessageIds = new Set<string>();

    for (const [index, message] of messages.entries()) {
      if (seenMessageIds.has(message.messageId)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate message",
          path: ["messages", index, "messageId"],
        });
      }
      seenMessageIds.add(message.messageId);
    }
  });

export type ReclassifyMessagesBody = z.infer<typeof reclassifyMessagesBody>;
