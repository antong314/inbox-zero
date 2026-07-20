export type HistoryPageSize = 100 | 500 | "all";

export function parseHistoryPageSize(value: string | null): HistoryPageSize {
  if (value === "500") return 500;
  if (value === "all") return "all";
  return 100;
}

export function paginateHistoryItems<T>({
  items,
  page,
  pageSize,
}: {
  items: T[];
  page: number;
  pageSize: HistoryPageSize;
}) {
  if (pageSize === "all") return items;

  const start = (Math.max(page, 1) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function getHistoryTotalPages(
  totalItems: number,
  pageSize: HistoryPageSize,
) {
  if (pageSize === "all") return 1;
  return Math.max(1, Math.ceil(totalItems / pageSize));
}
