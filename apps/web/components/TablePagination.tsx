import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationPrevious,
  PaginationLink,
  PaginationNext,
} from "@/components/ui/pagination";

export function TablePagination({ totalPages }: { totalPages: number }) {
  const searchParams = useSearchParams();
  const page = Math.max(
    1,
    Number.parseInt(searchParams.get("page") || "1") || 1,
  );
  const hrefForPage = useCallback(
    (value: number) => {
      const params = new URLSearchParams(searchParams);
      params.set("page", value.toString());
      const asString = params.toString();
      return asString ? `?${asString}` : "";
    },
    [searchParams],
  );

  if (totalPages <= 1) return null;

  return (
    <div className="m-4 flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          {page > 1 && (
            <PaginationItem>
              <PaginationPrevious href={hrefForPage(page - 1)} />
            </PaginationItem>
          )}
          <PaginationItem>
            <PaginationLink href={hrefForPage(page)}>{page}</PaginationLink>
          </PaginationItem>
          {page < totalPages && (
            <PaginationItem>
              <PaginationNext href={hrefForPage(page + 1)} />
            </PaginationItem>
          )}
        </PaginationContent>
      </Pagination>
    </div>
  );
}
