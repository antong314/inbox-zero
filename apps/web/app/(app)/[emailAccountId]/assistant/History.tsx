"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { ChevronDown, ChevronRightIcon, Tags } from "lucide-react";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import { format, isToday, isYesterday } from "date-fns";
import { LoadingContent } from "@/components/LoadingContent";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";
import type { RulesResponse } from "@/app/api/user/rules/route";
import { AlertBasic } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { TablePagination } from "@/components/TablePagination";
import { Badge } from "@/components/Badge";
import { RulesSelect } from "@/app/(app)/[emailAccountId]/assistant/RulesSelect";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useChat } from "@/providers/ChatProvider";
import { useExecutedRules } from "@/hooks/useExecutedRules";
import { useMessagesBatch } from "@/hooks/useMessagesBatch";
import type { ParsedMessage } from "@/utils/types";
import { EmailMessageCell } from "@/components/EmailMessageCell";
import { FixWithChat } from "@/app/(app)/[emailAccountId]/assistant/FixWithChat";
import { ResultsDisplay } from "@/app/(app)/[emailAccountId]/assistant/ResultDisplay";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRules } from "@/hooks/useRules";
import { shouldLearnFromLabelRemoval } from "@/utils/rule/consts";
import { sortRulesByCanonicalOrder } from "@/utils/rule/sort";
import { reclassifyMessagesAction } from "@/utils/actions/reclassify";
import { toastError, toastInfo, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { extractNameFromEmail } from "@/utils/email";

type ExecutedRuleResult = GetExecutedRulesResponse["results"][number];

// The messages batch endpoint and the reclassify action both accept at most
// 100 messages, so larger pages fall back to the server-provided summaries.
const MAX_BATCH_SIZE = 100;

type Selection = {
  isSelected: (messageId: string) => boolean;
  toggle: (messageId: string, checked: boolean) => void;
};

type Reclassify = {
  rules: RulesResponse;
  isExecuting: boolean;
  onReclassify: (messageId: string, targetRuleId: string) => void;
};

export function History() {
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));
  const [ruleId] = useQueryState("ruleId", parseAsString.withDefault("all"));
  const [pageSize, setPageSize] = useQueryState(
    "pageSize",
    parseAsString.withDefault("100"),
  );

  const { data, isLoading, error, mutate } = useExecutedRules({
    page: Math.max(page, 1),
    pageSize,
    ruleId,
  });
  const results = data?.results ?? [];
  const totalPages = data?.totalPages ?? 1;
  const messageIds = useMemo(
    () => results.slice(0, MAX_BATCH_SIZE).map((result) => result.messageId),
    [results],
  );
  const { data: messagesData, isLoading: isMessagesLoading } = useMessagesBatch(
    {
      ids: messageIds,
    },
  );
  const messages = messagesData?.messages ?? [];
  const messagesById = useMemo(() => mapMessagesById(messages), [messages]);

  useEffect(() => {
    if (page < 1) {
      setPage(1);
    } else if (
      data &&
      data.totalCount > 0 &&
      results.length === 0 &&
      page > 1
    ) {
      setPage(1);
    }
  }, [data, page, results.length, setPage]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RulesSelect />
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-sm text-muted-foreground">
              {data.totalCount.toLocaleString()} conversations
            </span>
          )}
          <Select
            value={pageSize}
            onValueChange={async (value) => {
              await Promise.all([setPage(1), setPageSize(value)]);
            }}
          >
            <SelectTrigger className="h-10 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="100">Show 100</SelectItem>
              <SelectItem value="500">Show 500</SelectItem>
              <SelectItem value="all">Show all</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Card className="mt-2 min-w-0">
        <LoadingContent loading={isLoading} error={error}>
          {results.length ? (
            <HistoryTable
              key={`${page}-${ruleId}-${pageSize}`}
              ruleId={ruleId}
              data={results}
              totalPages={totalPages}
              messagesById={messagesById}
              messagesLoading={isMessagesLoading}
              detailMessageIds={messageIds}
              refresh={async () => {
                await mutate();
              }}
            />
          ) : (
            <AlertBasic
              title="No history"
              description={
                ruleId === "all"
                  ? "No emails have been processed yet."
                  : "No emails have been processed for this rule."
              }
            />
          )}
        </LoadingContent>
      </Card>
    </>
  );
}

function HistoryTable({
  data,
  ruleId,
  totalPages,
  messagesById,
  messagesLoading,
  detailMessageIds,
  refresh,
}: {
  data: GetExecutedRulesResponse["results"];
  ruleId: string;
  totalPages: number;
  messagesById: Record<string, ParsedMessage>;
  messagesLoading: boolean;
  detailMessageIds: string[];
  refresh: () => Promise<void>;
}) {
  const groups = useMemo(() => groupByDate(data), [data]);
  const detailIds = useMemo(
    () => new Set(detailMessageIds),
    [detailMessageIds],
  );
  const { emailAccountId, provider } = useAccount();
  const { data: rules } = useRules();
  const [selectedMessages, setSelectedMessages] = useState<
    Map<string, { messageId: string }>
  >(new Map());
  const isBulkReclassification = useRef(false);
  const classificationRules = useMemo(
    () =>
      sortRulesByCanonicalOrder(
        (isGoogleProvider(provider) ? (rules ?? []) : []).filter(
          (rule) =>
            rule.enabled &&
            rule.systemType &&
            shouldLearnFromLabelRemoval(rule.systemType) &&
            rule.actions.some((action) => action.type === "LABEL"),
        ),
      ),
    [provider, rules],
  );
  const selectableData = data.slice(0, MAX_BATCH_SIZE);
  const selectedPageCount = selectableData.filter((item) =>
    selectedMessages.has(item.messageId),
  ).length;
  const canReclassify = classificationRules.length > 0;
  const allPageSelected =
    selectableData.length > 0 && selectedPageCount === selectableData.length;
  const columnCount = canReclassify ? 3 : 2;
  const { execute: reclassify, isExecuting } = useAction(
    reclassifyMessagesAction.bind(null, emailAccountId),
    {
      onSuccess: async ({ data: result }) => {
        if (!result) return;
        const retryMessageIds = new Set([
          ...result.failedMessageIds,
          ...result.failedLearningMessageIds,
        ]);
        if (isBulkReclassification.current) {
          setSelectedMessages(
            new Map(
              [...retryMessageIds].map((messageId) => [
                messageId,
                { messageId },
              ]),
            ),
          );
        }
        await refresh();
        if (retryMessageIds.size > 0) {
          toastInfo({
            title: "Some corrections need another try",
            description: isBulkReclassification.current
              ? `${result.reclassifiedCount} email${result.reclassifiedCount === 1 ? "" : "s"} updated. ${retryMessageIds.size} remain selected so you can retry them.`
              : "This email could not be fully reclassified. Please try again.",
          });
        } else {
          toastSuccess({
            description: `Reclassified ${result.reclassifiedCount} email${result.reclassifiedCount === 1 ? "" : "s"} from ${result.senderCount} sender${result.senderCount === 1 ? "" : "s"}. Future emails from these senders will use the selected classification.`,
          });
        }
      },
      onError: ({ error }) => {
        toastError({ description: getActionErrorMessage(error) });
      },
    },
  );

  const selection: Selection | undefined = canReclassify
    ? {
        isSelected: (messageId) => selectedMessages.has(messageId),
        toggle: (messageId, checked) => {
          setSelectedMessages((current) => {
            const next = new Map(current);
            if (checked && next.size < MAX_BATCH_SIZE) {
              next.set(messageId, { messageId });
            } else {
              next.delete(messageId);
            }
            return next;
          });
        },
      }
    : undefined;

  const reclassifyRow: Reclassify | undefined = canReclassify
    ? {
        rules: classificationRules,
        isExecuting,
        onReclassify: (messageId, targetRuleId) => {
          isBulkReclassification.current = false;
          reclassify({ targetRuleId, messages: [{ messageId }] });
        },
      }
    : undefined;

  return (
    <div>
      {canReclassify && (
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <label
            htmlFor="select-history-page"
            className="flex cursor-pointer items-center gap-2 text-sm"
          >
            <Checkbox
              id="select-history-page"
              checked={
                allPageSelected
                  ? true
                  : selectedPageCount > 0
                    ? "indeterminate"
                    : false
              }
              onCheckedChange={(checked) => {
                setSelectedMessages((current) => {
                  const next = new Map(current);
                  for (const item of selectableData) {
                    if (checked === true) {
                      if (next.size < MAX_BATCH_SIZE) {
                        next.set(item.messageId, {
                          messageId: item.messageId,
                        });
                      }
                    } else {
                      next.delete(item.messageId);
                    }
                  }
                  return next;
                });
              }}
            />
            {data.length > MAX_BATCH_SIZE ? "Select first 100" : "Select page"}
          </label>
          {selectedMessages.size > 0 && (
            <>
              <span className="text-sm font-medium">
                {selectedMessages.size} selected
              </span>
              <ClassificationPicker
                rules={classificationRules}
                disabled={isExecuting}
                label={isExecuting ? "Reclassifying..." : "Reclassify selected"}
                onSelect={(targetRuleId) => {
                  isBulkReclassification.current = true;
                  reclassify({
                    targetRuleId,
                    messages: [...selectedMessages.values()],
                  });
                }}
              />
              <span className="text-xs text-muted-foreground">
                Also remembers each sender for future emails
              </span>
            </>
          )}
        </div>
      )}
      <Table>
        <TableBody>
          {groups.map((group) => (
            <Fragment key={group.key}>
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columnCount}
                  className="bg-muted/40 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {formatDateGroupLabel(group.date)}
                </TableCell>
              </TableRow>
              {group.items.map((er) => (
                <HistoryThread
                  key={er.threadId}
                  result={er}
                  ruleId={ruleId}
                  message={messagesById[er.messageId]}
                  messagesLoading={
                    messagesLoading && detailIds.has(er.messageId)
                  }
                  columnCount={columnCount}
                  selection={selection}
                  reclassify={reclassifyRow}
                />
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>

      <TablePagination totalPages={totalPages} />
    </div>
  );
}

function HistoryThread({
  result,
  ruleId,
  message,
  messagesLoading,
  columnCount,
  selection,
  reclassify,
}: {
  result: ExecutedRuleResult;
  ruleId: string;
  message?: ParsedMessage;
  messagesLoading: boolean;
  columnCount: number;
  selection?: Selection;
  reclassify?: Reclassify;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <HistoryMessageRow
        result={result}
        message={message}
        messagesLoading={messagesLoading}
        selection={selection}
        reclassify={reclassify}
        leading={
          result.messageCount > 1 ? (
            <Button
              variant="ghost"
              size="iconSm"
              aria-label={
                expanded ? "Collapse conversation" : "Expand conversation"
              }
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronRightIcon
                className={expanded ? "size-4 rotate-90" : "size-4"}
              />
            </Button>
          ) : undefined
        }
        messageCount={result.messageCount}
      />
      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={columnCount} className="pl-10">
            <ThreadHistory
              threadId={result.threadId}
              latestMessageId={result.messageId}
              ruleId={ruleId}
              reclassify={reclassify}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ThreadHistory({
  threadId,
  latestMessageId,
  ruleId,
  reclassify,
}: {
  threadId: string;
  latestMessageId: string;
  ruleId: string;
  reclassify?: Reclassify;
}) {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useExecutedRules({
    page,
    ruleId,
    threadId,
    excludeMessageId: latestMessageId,
  });
  const results = data?.results ?? [];
  const ids = results.map((result) => result.messageId);
  const {
    data: messagesData,
    isLoading: messagesLoading,
    error: messagesError,
  } = useMessagesBatch({ ids });
  const messagesById = mapMessagesById(messagesData?.messages ?? []);

  return (
    <LoadingContent loading={isLoading} error={error || messagesError}>
      {data && (
        <>
          <Table>
            <TableBody>
              {results.map((result) => (
                <HistoryMessageRow
                  key={result.messageId}
                  result={result}
                  message={messagesById[result.messageId]}
                  messagesLoading={messagesLoading}
                  reclassify={reclassify}
                />
              ))}
            </TableBody>
          </Table>
          {data.totalPages > 1 && (
            <div className="flex items-center justify-end gap-2 py-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous messages
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next messages
              </Button>
            </div>
          )}
        </>
      )}
    </LoadingContent>
  );
}

function HistoryMessageRow({
  result,
  message,
  messagesLoading,
  leading,
  messageCount,
  selection,
  reclassify,
}: {
  result: ExecutedRuleResult;
  message?: ParsedMessage;
  messagesLoading: boolean;
  leading?: React.ReactNode;
  messageCount?: number;
  selection?: Selection;
  reclassify?: Reclassify;
}) {
  const { userEmail } = useAccount();
  const { setInput } = useChat();
  const isMessageLoading = !message && messagesLoading;
  return (
    <TableRow>
      {selection && (
        <TableCell className="w-10 pr-0 align-top">
          <Checkbox
            aria-label={`Select email ${result.messageId}`}
            checked={selection.isSelected(result.messageId)}
            onCheckedChange={(checked) =>
              selection.toggle(result.messageId, checked === true)
            }
          />
        </TableCell>
      )}
      <TableCell className="min-w-0">
        <div className="flex items-start gap-2">
          {leading}
          <div className="min-w-0 flex-1">
            <EmailCell
              message={message}
              result={result}
              userEmail={userEmail}
              isMessageLoading={isMessageLoading}
            />
            {messageCount === undefined &&
              result.executedRules[0]?.createdAt && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {format(
                    new Date(result.executedRules[0].createdAt),
                    "MMM d, yyyy, p",
                  )}
                </div>
              )}
            <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
              {messageCount && messageCount > 1 ? (
                <Badge color="blue">{messageCount} messages handled</Badge>
              ) : null}
              {!result.executedRules[0]?.automated && (
                <Badge color="yellow">Applied manually</Badge>
              )}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <RuleCell
          executedRules={result.executedRules}
          message={message}
          setInput={setInput}
          isMessageLoading={isMessageLoading}
          reclassify={
            reclassify
              ? {
                  ...reclassify,
                  onSelect: (targetRuleId) =>
                    reclassify.onReclassify(result.messageId, targetRuleId),
                }
              : undefined
          }
        />
      </TableCell>
    </TableRow>
  );
}

function EmailCell({
  message,
  result,
  userEmail,
  isMessageLoading,
}: {
  message?: ParsedMessage;
  result: ExecutedRuleResult;
  userEmail: string;
  isMessageLoading: boolean;
}) {
  if (message) {
    return (
      <EmailMessageCell
        sender={message.headers.from}
        subject={message.headers.subject}
        snippet={message.snippet}
        userEmail={userEmail}
        threadId={result.threadId}
        messageId={result.messageId}
        labelIds={message.labelIds}
      />
    );
  }

  if (isMessageLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-4 w-80" />
      </div>
    );
  }

  if (result.sender || result.subject) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span
          className="max-w-56 shrink-0 truncate font-medium"
          title={result.sender ?? undefined}
        >
          {result.sender
            ? extractNameFromEmail(result.sender)
            : "Unknown sender"}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {result.subject || "No subject"}
        </span>
      </div>
    );
  }

  return (
    <span className="text-sm text-muted-foreground">Email unavailable</span>
  );
}

function RuleCell({
  executedRules,
  message,
  setInput,
  isMessageLoading,
  reclassify,
}: {
  executedRules: GetExecutedRulesResponse["results"][number]["executedRules"];
  message?: ParsedMessage;
  setInput: (input: string) => void;
  isMessageLoading: boolean;
  reclassify?: Reclassify & { onSelect: (targetRuleId: string) => void };
}) {
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <div className="shrink-0">
        <ResultsDisplay results={executedRules} />
      </div>
      {reclassify && (
        <ClassificationPicker
          rules={reclassify.rules}
          disabled={reclassify.isExecuting}
          label="Reclassify"
          compact
          onSelect={reclassify.onSelect}
        />
      )}
      {message ? (
        <FixWithChat
          setInput={setInput}
          message={message}
          results={executedRules}
        />
      ) : isMessageLoading ? (
        <Skeleton className="h-9 w-16" />
      ) : (
        <Button variant="outline" size="sm" disabled>
          Fix
        </Button>
      )}
    </div>
  );
}

function ClassificationPicker({
  rules,
  disabled,
  label,
  compact = false,
  onSelect,
}: {
  rules: RulesResponse;
  disabled: boolean;
  label: string;
  compact?: boolean;
  onSelect: (targetRuleId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 whitespace-nowrap px-2"
          disabled={disabled}
          aria-label={label}
          title={compact ? label : undefined}
        >
          <Tags className={compact ? "size-4" : "mr-1.5 size-4"} />
          <span className={compact ? "sr-only" : ""}>{label}</span>
          <ChevronDown
            className={
              compact ? "hidden" : "ml-1.5 size-3.5 text-muted-foreground"
            }
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {rules.map((rule) => (
          <DropdownMenuItem key={rule.id} onClick={() => onSelect(rule.id)}>
            {rule.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function mapMessagesById(messages: ParsedMessage[]) {
  return messages.reduce<Record<string, ParsedMessage>>((acc, message) => {
    acc[message.id] = message;
    return acc;
  }, {});
}

function groupByDate(items: ExecutedRuleResult[]) {
  const groups: {
    key: string;
    date: Date | null;
    items: ExecutedRuleResult[];
  }[] = [];
  for (const item of items) {
    const createdAt = item.executedRules[0]?.createdAt;
    const date = createdAt ? new Date(createdAt) : null;
    const key = date ? format(date, "yyyy-MM-dd") : "unknown";
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, date, items: [item] });
    }
  }
  return groups;
}

function formatDateGroupLabel(date: Date | null) {
  if (!date) return "Unknown date";
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  if (date.getFullYear() === new Date().getFullYear()) {
    return format(date, "EEEE, MMM d");
  }
  return format(date, "EEEE, MMM d, yyyy");
}
