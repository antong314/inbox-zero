import { useRules } from "@/hooks/useRules";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingContent } from "@/components/LoadingContent";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { parseAsString, useQueryState } from "nuqs";
import { ChevronDown, Tag } from "lucide-react";
import { sortRulesForAutomation } from "@/utils/rule/sort";

export function RulesSelect() {
  const { data, isLoading, error } = useRules();
  const [ruleId, setRuleId] = useQueryState(
    "ruleId",
    parseAsString.withDefault("all"),
  );
  const [, setPage] = useQueryState("page");
  const sortedRules = data ? sortRulesForAutomation(data) : undefined;
  const selectRule = async (nextRuleId: string) => {
    await Promise.all([setRuleId(nextRuleId), setPage("1")]);
  };

  const getCurrentLabel = () => {
    if (ruleId === "all") return "All rules";
    if (ruleId === "skipped") return "No match";
    const rule = sortedRules?.find((rule) => rule.id === ruleId);
    if (!rule) return "All rules";
    return rule.enabled ? rule.name : `${rule.name} (disabled)`;
  };

  return (
    <LoadingContent
      loading={isLoading}
      error={error}
      loadingComponent={<Skeleton className="h-10 w-[200px]" />}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-10 whitespace-nowrap"
          >
            <Tag className="mr-2 h-4 w-4" />
            {getCurrentLabel()}
            <ChevronDown className="ml-2 h-4 w-4 text-gray-400" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => selectRule("all")}>
            All rules
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => selectRule("skipped")}>
            No match
          </DropdownMenuItem>
          {sortedRules?.map((rule) => (
            <DropdownMenuItem key={rule.id} onClick={() => selectRule(rule.id)}>
              {rule.name}
              {!rule.enabled && (
                <span className="ml-1 text-muted-foreground">(disabled)</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </LoadingContent>
  );
}
