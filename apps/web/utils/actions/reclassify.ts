"use server";

import groupBy from "lodash/groupBy";
import PQueue from "p-queue";
import {
  ActionType,
  ClassificationFeedbackEventType,
  ExecutedRuleStatus,
} from "@/generated/prisma/enums";
import { actionClient } from "@/utils/actions/safe-action";
import { reclassifyMessagesBody } from "@/utils/actions/reclassify.validation";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { extractEmailAddress } from "@/utils/email";
import { SafeError } from "@/utils/error";
import { labelMessageAndSync } from "@/utils/label.server";
import prisma from "@/utils/prisma";
import { saveClassificationFeedback } from "@/utils/rule/classification-feedback";
import { shouldLearnFromLabelRemoval } from "@/utils/rule/consts";
import { setSenderClassification } from "@/utils/rule/reclassify-sender";

export const reclassifyMessagesAction = actionClient
  .metadata({ name: "reclassifyMessages" })
  .inputSchema(reclassifyMessagesBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { messages: inputMessages, targetRuleId },
    }) => {
      if (!provider || !isGoogleProvider(provider)) {
        throw new SafeError(
          "Fast reclassification is currently available for Gmail accounts",
        );
      }

      const [emailProvider, rules, previousExecutions] = await Promise.all([
        createEmailProvider({ emailAccountId, provider, logger }),
        prisma.rule.findMany({
          where: {
            emailAccountId,
            enabled: true,
            systemType: { not: null },
          },
          select: {
            id: true,
            name: true,
            systemType: true,
            actions: {
              where: { type: ActionType.LABEL },
              select: {
                id: true,
                type: true,
                label: true,
                labelId: true,
              },
            },
          },
        }),
        prisma.executedRule.findMany({
          where: {
            emailAccountId,
            messageId: {
              in: inputMessages.map(({ messageId }) => messageId),
            },
            status: ExecutedRuleStatus.APPLIED,
            rule: { systemType: { not: null } },
          },
          select: {
            id: true,
            messageId: true,
            ruleId: true,
            rule: { select: { systemType: true } },
          },
        }),
      ]);

      const classificationRules = rules.filter(
        (rule) =>
          rule.systemType &&
          shouldLearnFromLabelRemoval(rule.systemType) &&
          rule.actions.length > 0,
      );
      const targetRule = classificationRules.find(
        (rule) => rule.id === targetRuleId,
      );
      const targetLabelAction = targetRule?.actions[0];
      const removeMessageLabels =
        emailProvider.removeMessageLabels?.bind(emailProvider);

      if (!targetRule || !targetLabelAction) {
        throw new SafeError("Classification rule not found");
      }
      if (!removeMessageLabels) {
        throw new SafeError("Message label removal is not supported");
      }

      const targetLabelId = await getOrCreateTargetLabelId({
        action: targetLabelAction,
        emailAccountId,
        emailProvider,
      });
      const competingLabelIds = await getExistingCompetingLabelIds({
        actions: classificationRules
          .filter((rule) => rule.id !== targetRuleId)
          .flatMap((rule) => rule.actions),
        emailAccountId,
        emailProvider,
      });
      const fetchedMessages = await emailProvider.getMessagesBatch(
        inputMessages.map(({ messageId }) => messageId),
      );
      const fetchedMessagesById = new Map(
        fetchedMessages.map((message) => [message.id, message]),
      );
      const previousExecutionsByMessageId = groupBy(
        previousExecutions,
        ({ messageId }) => messageId,
      );
      const senders = new Set<string>();
      const messageIdsBySender = new Map<string, Set<string>>();
      const queue = new PQueue({ concurrency: 4 });
      const failures = new Set<string>();

      await Promise.all(
        inputMessages.map((inputMessage) =>
          queue.add(async () => {
            try {
              const message = fetchedMessagesById.get(inputMessage.messageId);
              const sender = extractEmailAddress(message?.headers.from ?? "");

              if (!message || !sender) {
                failures.add(inputMessage.messageId);
                return;
              }

              const normalizedSender = sender.toLowerCase();

              await labelMessageAndSync({
                provider: emailProvider,
                messageId: inputMessage.messageId,
                labelId: targetLabelId,
                labelName: targetLabelAction.label,
                emailAccountId,
                logger,
              });

              if (competingLabelIds.length > 0) {
                await removeMessageLabels(message.id, competingLabelIds);
              }

              const previousRules =
                previousExecutionsByMessageId[inputMessage.messageId] ?? [];
              const previousClassificationRules = previousRules.filter(
                (execution) =>
                  execution.rule.systemType &&
                  shouldLearnFromLabelRemoval(execution.rule.systemType),
              );
              const wrongRuleExecutions = previousClassificationRules.filter(
                (execution) =>
                  execution.ruleId && execution.ruleId !== targetRuleId,
              );

              for (const execution of wrongRuleExecutions) {
                await saveClassificationFeedback({
                  emailAccountId,
                  sender: normalizedSender,
                  ruleId: execution.ruleId!,
                  threadId: message.threadId,
                  messageId: inputMessage.messageId,
                  eventType: ClassificationFeedbackEventType.LABEL_REMOVED,
                  logger,
                });
              }

              await saveClassificationFeedback({
                emailAccountId,
                sender: normalizedSender,
                ruleId: targetRuleId,
                threadId: message.threadId,
                messageId: inputMessage.messageId,
                eventType: ClassificationFeedbackEventType.LABEL_ADDED,
                logger,
              });

              if (wrongRuleExecutions.length > 0) {
                await prisma.executedRule.updateMany({
                  where: {
                    id: {
                      in: wrongRuleExecutions.map((execution) => execution.id),
                    },
                  },
                  data: {
                    status: ExecutedRuleStatus.SKIPPED,
                    reason: `Reclassified by user as ${targetRule.name}`,
                  },
                });
              }

              const alreadyClassifiedAsTarget =
                previousClassificationRules.some(
                  (execution) => execution.ruleId === targetRuleId,
                );

              if (!alreadyClassifiedAsTarget) {
                await prisma.executedRule.create({
                  data: {
                    emailAccountId,
                    messageId: inputMessage.messageId,
                    threadId: message.threadId,
                    status: ExecutedRuleStatus.APPLIED,
                    automated: false,
                    reason: `Reclassified by user as ${targetRule.name}`,
                    ruleId: targetRuleId,
                    actionItems: {
                      create: {
                        type: ActionType.LABEL,
                        label: targetLabelAction.label,
                        labelId: targetLabelId,
                      },
                    },
                  },
                });
              }

              senders.add(normalizedSender);
              const senderMessageIds =
                messageIdsBySender.get(normalizedSender) ?? new Set<string>();
              senderMessageIds.add(inputMessage.messageId);
              messageIdsBySender.set(normalizedSender, senderMessageIds);
            } catch (error) {
              failures.add(inputMessage.messageId);
              logger.error("Failed to reclassify message", {
                error,
                messageId: inputMessage.messageId,
              });
            }
          }),
        ),
      );

      const failedLearningMessageIds = new Set<string>();
      const learningQueue = new PQueue({ concurrency: 4 });

      await Promise.all(
        [...senders].map((sender) =>
          learningQueue.add(async () => {
            try {
              await setSenderClassification({
                emailAccountId,
                sender,
                targetRuleId,
                classificationRuleIds: classificationRules.map(
                  (rule) => rule.id,
                ),
                logger,
              });
            } catch (error) {
              logger.error("Failed to remember sender classification", {
                error,
              });
              for (const messageId of messageIdsBySender.get(sender) ?? []) {
                failedLearningMessageIds.add(messageId);
              }
            }
          }),
        ),
      );

      return {
        reclassifiedCount: inputMessages.length - failures.size,
        senderCount: senders.size,
        failedMessageIds: [...failures],
        failedLearningMessageIds: [...failedLearningMessageIds],
      };
    },
  );

async function getOrCreateTargetLabelId({
  action,
  emailAccountId,
  emailProvider,
}: {
  action: { id: string; label: string | null; labelId: string | null };
  emailAccountId: string;
  emailProvider: Awaited<ReturnType<typeof createEmailProvider>>;
}) {
  if (action.labelId) {
    const existingLabel = await emailProvider.getLabelById(action.labelId);
    if (existingLabel) return existingLabel.id;
  }

  if (!action.label) throw new SafeError("Classification label not configured");

  const existingLabel = await emailProvider.getLabelByName(action.label);
  const labelId =
    existingLabel?.id ?? (await emailProvider.createLabel(action.label)).id;

  if (!labelId) throw new SafeError("Could not create classification label");

  await prisma.action.updateMany({
    where: { id: action.id, emailAccountId },
    data: { labelId },
  });

  return labelId;
}

async function getExistingCompetingLabelIds({
  actions,
  emailAccountId,
  emailProvider,
}: {
  actions: Array<{
    id: string;
    label: string | null;
    labelId: string | null;
  }>;
  emailAccountId: string;
  emailProvider: Awaited<ReturnType<typeof createEmailProvider>>;
}) {
  const labelIds = await Promise.all(
    actions.map(async (action) => {
      const labelById = action.labelId
        ? await emailProvider.getLabelById(action.labelId)
        : null;
      const labelId =
        labelById?.id ??
        (action.label
          ? (await emailProvider.getLabelByName(action.label))?.id
          : null);

      if (labelId && labelId !== action.labelId) {
        await prisma.action.updateMany({
          where: { id: action.id, emailAccountId },
          data: { labelId },
        });
      }

      return labelId;
    }),
  );

  return labelIds.filter((labelId): labelId is string => Boolean(labelId));
}
