import { GroupItemSource } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import { saveLearnedPattern } from "@/utils/rule/learned-patterns";

export async function setSenderClassification({
  emailAccountId,
  sender,
  targetRuleId,
  classificationRuleIds,
  logger,
}: {
  emailAccountId: string;
  sender: string;
  targetRuleId: string;
  classificationRuleIds: string[];
  logger: Logger;
}) {
  if (!classificationRuleIds.includes(targetRuleId)) {
    throw new Error("Target classification rule not found");
  }

  const normalizedSender = sender.toLowerCase();

  for (const ruleId of classificationRuleIds) {
    if (ruleId === targetRuleId) continue;

    await saveLearnedPattern({
      emailAccountId,
      from: normalizedSender,
      ruleId,
      exclude: true,
      logger,
      reason: `User moved sender to rule ${targetRuleId}`,
      source: GroupItemSource.USER,
    });
  }

  await saveLearnedPattern({
    emailAccountId,
    from: normalizedSender,
    ruleId: targetRuleId,
    exclude: false,
    logger,
    reason: "User selected this classification for future emails",
    source: GroupItemSource.USER,
  });
}
