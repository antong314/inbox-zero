"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "next-safe-action/hooks";
import { useQueryState, parseAsInteger, parseAsString } from "nuqs";
import { ChevronDown, Tags } from "lucide-react";
import { LoadingContent } from "@/components/LoadingContent";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";
import type { RulesResponse } from "@/app/api/user/rules/route";
import { AlertBasic } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { TablePagination } from "@/components/TablePagination";
import { RulesSelect } from "@/app/(app)/[emailAccountId]/assistant/RulesSelect";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useExecutedRules } from "@/hooks/useExecutedRules";
import { ResultsDisplay } from "@/app/(app)/[emailAccountId]/assistant/ResultDisplay";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRules } from "@/hooks/useRules";
import { shouldLearnFromLabelRemoval } from "@/utils/rule/consts";
import { sortRulesForAutomation } from "@/utils/rule/sort";
import { reclassifyMessagesAction } from "@/utils/actions/reclassify";
import { toastError, toastInfo, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { isGoogleProvider } from "@/utils/email/provider-types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractNameFromEmail } from "@/utils/email";

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
              {data.totalCount.toLocaleString()} emails
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
      <Card className="mt-2">
        <LoadingContent loading={isLoading} error={error}>
          {results.length ? (
            <HistoryTable
              data={results}
              totalPages={totalPages}
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
  totalPages,
  refresh,
}: {
  data: GetExecutedRulesResponse["results"];
  totalPages: number;
  refresh: () => Promise<void>;
}) {
  const { emailAccountId, provider } = useAccount();
  const { data: rules } = useRules();
  const [selectedMessages, setSelectedMessages] = useState<
    Map<string, { messageId: string }>
  >(new Map());
  const isBulkReclassification = useRef(false);
  const classificationRules = useMemo(
    () =>
      sortRulesForAutomation(
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
  const selectableData = data.slice(0, 100);
  const selectedPageCount = selectableData.filter((item) =>
    selectedMessages.has(item.messageId),
  ).length;
  const canReclassify = classificationRules.length > 0;
  const allPageSelected =
    selectableData.length > 0 && selectedPageCount === selectableData.length;
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
                      if (next.size < 100) {
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
            {data.length > 100 ? "Select first 100" : "Select page"}
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
          {data.map((executedRule) => (
            <TableRow key={executedRule.messageId} className="h-10">
              {canReclassify && (
                <TableCell className="w-10 py-1 pr-0">
                  <Checkbox
                    aria-label={`Select email ${executedRule.messageId}`}
                    checked={selectedMessages.has(executedRule.messageId)}
                    onCheckedChange={(checked) => {
                      setSelectedMessages((current) => {
                        const next = new Map(current);
                        if (checked === true && next.size < 100) {
                          next.set(executedRule.messageId, {
                            messageId: executedRule.messageId,
                          });
                        } else {
                          next.delete(executedRule.messageId);
                        }
                        return next;
                      });
                    }}
                  />
                </TableCell>
              )}
              <TableCell className="min-w-0 py-1.5">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <span
                    className="max-w-56 shrink-0 truncate font-medium"
                    title={executedRule.sender ?? undefined}
                  >
                    {executedRule.sender
                      ? extractNameFromEmail(executedRule.sender)
                      : "Unknown sender"}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {executedRule.subject || "No subject"}
                  </span>
                </div>
              </TableCell>
              <TableCell className="w-px py-1">
                <RuleCell
                  executedRules={executedRule.executedRules}
                  classificationRules={classificationRules}
                  reclassifying={isExecuting}
                  onReclassify={(targetRuleId) => {
                    isBulkReclassification.current = false;
                    reclassify({
                      targetRuleId,
                      messages: [{ messageId: executedRule.messageId }],
                    });
                  }}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <TablePagination totalPages={totalPages} />
    </div>
  );
}

function RuleCell({
  executedRules,
  classificationRules,
  reclassifying,
  onReclassify,
}: {
  executedRules: GetExecutedRulesResponse["results"][number]["executedRules"];
  classificationRules: RulesResponse;
  reclassifying: boolean;
  onReclassify: (targetRuleId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div>
        <ResultsDisplay results={executedRules} />
      </div>
      {classificationRules.length > 0 && (
        <ClassificationPicker
          rules={classificationRules}
          disabled={reclassifying}
          label="Reclassify"
          onSelect={onReclassify}
        />
      )}
    </div>
  );
}

function ClassificationPicker({
  rules,
  disabled,
  label,
  onSelect,
}: {
  rules: RulesResponse;
  disabled: boolean;
  label: string;
  onSelect: (targetRuleId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={disabled}
        >
          <Tags className="mr-1.5 size-4" />
          {label}
          <ChevronDown className="ml-1.5 size-3.5 text-muted-foreground" />
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
