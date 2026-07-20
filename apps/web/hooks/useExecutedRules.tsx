import useSWR from "swr";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";

export function useExecutedRules({
  page,
  pageSize,
  ruleId,
}: {
  page: number;
  pageSize: string;
  ruleId: string;
}) {
  return useSWR<GetExecutedRulesResponse>(
    `/api/user/executed-rules/history?page=${page}&pageSize=${pageSize}&ruleId=${ruleId}`,
  );
}
