import { NextResponse } from "next/server";
import chunk from "lodash/chunk";
import groupBy from "lodash/groupBy";
import PQueue from "p-queue";
import { serializedMatchMetadataSchema } from "@/utils/ai/assistant/chat-context-validation";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  getHistoryTotalPages,
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
    const requestedPage = Number(url.searchParams.get("page") || "1");
    const page =
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;
    const threadId = url.searchParams.get("threadId") || undefined;
    const excludeMessageId = threadId
      ? url.searchParams.get("excludeMessageId") || undefined
      : undefined;
    const ruleId = url.searchParams.get("ruleId") || "all";
    const pageSize = parseHistoryPageSize(url.searchParams.get("pageSize"));

    const result = await getExecutedRules({
      page,
      pageSize,
      ruleId,
      emailAccountId,
      threadId,
      excludeMessageId,
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
  threadId,
  excludeMessageId,
  emailProvider,
  logger,
}: {
  page: number;
  pageSize: HistoryPageSize;
  ruleId?: string;
  emailAccountId: string;
  threadId?: string;
  excludeMessageId?: string;
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  const conditions = [Prisma.sql`"emailAccountId" = ${emailAccountId}`];
  if (ruleId === "skipped") {
    conditions.push(
      Prisma.sql`status = ${ExecutedRuleStatus.SKIPPED}::"ExecutedRuleStatus"`,
    );
  } else {
    conditions.push(
      Prisma.sql`status = ${ExecutedRuleStatus.APPLIED}::"ExecutedRuleStatus" AND "ruleId" IS NOT NULL`,
    );
    if (ruleId && ruleId !== "all") {
      conditions.push(Prisma.sql`"ruleId" = ${ruleId}`);
    }
  }
  if (threadId) conditions.push(Prisma.sql`"threadId" = ${threadId}`);
  if (excludeMessageId) {
    conditions.push(Prisma.sql`"messageId" != ${excludeMessageId}`);
  }
  const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
  const groupColumn = threadId
    ? Prisma.sql`"messageId"`
    : Prisma.sql`"threadId"`;

  const [messages, totals] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        threadId: string;
        messageId: string;
        ids: string[];
        messageCount: number;
      }>
    >(Prisma.sql`
      WITH messages AS (
        SELECT "threadId", "messageId", MAX("createdAt") AS "createdAt"
        FROM "ExecutedRule" ${where}
        GROUP BY "threadId", "messageId"
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY "threadId" ORDER BY "createdAt" DESC, "messageId") AS position,
          (COUNT(*) OVER (PARTITION BY "threadId"))::int AS "messageCount"
        FROM messages
      ), page AS (
        SELECT * FROM ranked
        ${threadId ? Prisma.empty : Prisma.sql`WHERE position = 1`}
        ORDER BY "createdAt" DESC, "threadId", "messageId"
        ${
          pageSize === "all"
            ? Prisma.empty
            : Prisma.sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
        }
      )
      SELECT page."threadId", page."messageId", page."messageCount",
        ARRAY(
          SELECT id FROM "ExecutedRule" ${where}
            AND "threadId" = page."threadId" AND "messageId" = page."messageId"
        ) AS ids
      FROM page
      ORDER BY page."createdAt" DESC, page."threadId", page."messageId"
    `),
    prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT ${groupColumn}) AS total FROM "ExecutedRule" ${where}
    `),
  ]);

  const executedRules = messages.length
    ? await prisma.executedRule.findMany({
        where: {
          emailAccountId,
          id: { in: messages.flatMap((message) => message.ids) },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
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
      })
    : [];

  const summaries = await fetchMessageSummaries({
    messageIds: messages.map((message) => message.messageId),
    emailProvider,
    logger,
  });
  const summariesById = new Map(
    summaries.map((summary) => [summary.id, summary]),
  );
  const executedRulesByMessageId = groupBy(executedRules, (er) => er.messageId);
  const results = messages
    .map(({ messageId, threadId, messageCount }) => ({
      messageId,
      threadId,
      messageCount,
      sender: summariesById.get(messageId)?.headers.from ?? null,
      subject: summariesById.get(messageId)?.headers.subject ?? null,
      executedRules: (executedRulesByMessageId[messageId] ?? []).map(
        (executedRule) => ({
          ...executedRule,
          matchMetadata:
            serializedMatchMetadataSchema.safeParse(executedRule.matchMetadata)
              .data ?? null,
        }),
      ),
    }))
    .filter((message) => message.executedRules.length > 0);

  const totalCount = Number(totals[0]?.total ?? 0);

  return {
    results,
    totalCount,
    totalPages: getHistoryTotalPages(totalCount, pageSize),
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
