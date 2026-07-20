import { NextResponse } from "next/server";
import chunk from "lodash/chunk";
import groupBy from "lodash/groupBy";
import PQueue from "p-queue";
import { serializedMatchMetadataSchema } from "@/utils/ai/assistant/chat-context-validation";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  getHistoryTotalPages,
  paginateHistoryItems,
  parseHistoryPageSize,
  type HistoryPageSize,
} from "@/utils/history-pagination";

export type GetExecutedRulesResponse = Awaited<
  ReturnType<typeof getExecutedRules>
>;

export const GET = withEmailProvider(
  "user/executed-rules/history",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;

    const url = new URL(request.url);
    const page = Number.parseInt(url.searchParams.get("page") || "1");
    const ruleId = url.searchParams.get("ruleId") || "all";
    const pageSize = parseHistoryPageSize(url.searchParams.get("pageSize"));

    const result = await getExecutedRules({
      page,
      pageSize,
      ruleId,
      emailAccountId,
      emailProvider: request.emailProvider,
      logger: request.logger,
    });

    return NextResponse.json(result);
  },
);

async function getExecutedRules({
  page,
  pageSize,
  ruleId,
  emailAccountId,
  emailProvider,
  logger,
}: {
  page: number;
  pageSize: HistoryPageSize;
  ruleId?: string;
  emailAccountId: string;
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  const where: Prisma.ExecutedRuleWhereInput = {
    emailAccountId,
    status:
      ruleId === "skipped"
        ? ExecutedRuleStatus.SKIPPED
        : ExecutedRuleStatus.APPLIED,
    rule: ruleId === "skipped" ? undefined : { isNot: null },
    ruleId: ruleId === "skipped" ? null : ruleId === "all" ? undefined : ruleId,
  };

  const distinctMessages = await prisma.executedRule.findMany({
    where,
    distinct: ["messageId"],
    orderBy: { createdAt: "desc" },
    select: { messageId: true },
  });
  const pageMessageIds = paginateHistoryItems({
    items: distinctMessages.map(({ messageId }) => messageId),
    page,
    pageSize,
  });
  const executedRules =
    pageMessageIds.length === 0
      ? []
      : await prisma.executedRule.findMany({
          where: {
            ...where,
            messageId: { in: pageMessageIds },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            messageId: true,
            threadId: true,
            actionItems: true,
            status: true,
            reason: true,
            matchMetadata: true,
            automated: true,
            createdAt: true,
            rule: {
              select: {
                id: true,
                name: true,
                systemType: true,
                instructions: true,
                groupId: true,
                from: true,
                to: true,
                subject: true,
                body: true,
                conditionalOperator: true,
                group: { select: { name: true } },
              },
            },
          },
        });
  const messages = await fetchMessageSummaries({
    messageIds: pageMessageIds,
    emailProvider,
    logger,
  });
  const messagesById = new Map(
    messages.map((message) => [message.id, message]),
  );
  const executedRulesByMessageId = groupBy(executedRules, (er) => er.messageId);

  const results = pageMessageIds.flatMap((messageId) => {
    const groupedExecutedRules = executedRulesByMessageId[messageId];
    if (!groupedExecutedRules?.length) return [];

    const message = messagesById.get(messageId);
    return [
      {
        messageId,
        threadId: groupedExecutedRules[0].threadId,
        sender: message?.headers.from ?? null,
        subject: message?.headers.subject ?? null,
        executedRules: groupedExecutedRules.map((executedRule) => ({
          ...executedRule,
          matchMetadata:
            serializedMatchMetadataSchema.safeParse(executedRule.matchMetadata)
              .data ?? null,
        })),
      },
    ];
  });

  return {
    results,
    totalCount: distinctMessages.length,
    totalPages: getHistoryTotalPages(distinctMessages.length, pageSize),
  };
}

async function fetchMessageSummaries({
  messageIds,
  emailProvider,
  logger,
}: {
  messageIds: string[];
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  const queue = new PQueue({ concurrency: 1 });
  const batches = chunk(messageIds, 100);

  const results = await Promise.all(
    batches.map((messageIdsBatch) =>
      queue.add(async () => {
        try {
          return await emailProvider.getMessagesBatch(messageIdsBatch);
        } catch (error) {
          logger.warn("Failed to load a batch of history messages", {
            error,
            messageCount: messageIdsBatch.length,
          });
          return fetchMessageSummariesIndividually({
            messageIds: messageIdsBatch,
            emailProvider,
          });
        }
      }),
    ),
  );

  return results.flatMap((result) => result ?? []);
}

async function fetchMessageSummariesIndividually({
  messageIds,
  emailProvider,
}: {
  messageIds: string[];
  emailProvider: EmailProvider;
}) {
  const queue = new PQueue({ concurrency: 4 });
  const results = await Promise.all(
    messageIds.map((messageId) =>
      queue.add(async () => {
        try {
          const [message] = await emailProvider.getMessagesBatch([messageId]);
          return message;
        } catch {
          return null;
        }
      }),
    ),
  );

  return results.filter((message) => message != null);
}
