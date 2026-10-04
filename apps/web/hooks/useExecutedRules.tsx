import useSWR from "swr";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";

export function useExecutedRules({
  page,
  pageSize,
  ruleId,
  threadId,
  excludeMessageId,
}: {
  page: number;
  pageSize?: string;
  ruleId: string;
  threadId?: string;
  excludeMessageId?: string;
}) {
  const params = new URLSearchParams({ page: String(page), ruleId });
  if (pageSize) params.set("pageSize", pageSize);
  if (threadId) params.set("threadId", threadId);
  if (excludeMessageId) params.set("excludeMessageId", excludeMessageId);
  return useSWR<GetExecutedRulesResponse>(
    `/api/user/executed-rules/history?${params}`,
  );
}
