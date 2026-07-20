import { describe, expect, it } from "vitest";
import {
  getHistoryTotalPages,
  paginateHistoryItems,
  parseHistoryPageSize,
} from "./history-pagination";

describe("history pagination", () => {
  it("defaults to 100 rows and supports 500 or all", () => {
    expect(parseHistoryPageSize(null)).toBe(100);
    expect(parseHistoryPageSize("unexpected")).toBe(100);
    expect(parseHistoryPageSize("500")).toBe(500);
    expect(parseHistoryPageSize("all")).toBe("all");
  });

  it("paginates rows and reports the total page count", () => {
    const items = Array.from({ length: 205 }, (_, index) => index);

    expect(
      paginateHistoryItems({ items, page: 2, pageSize: 100 }),
    ).toHaveLength(100);
    expect(
      paginateHistoryItems({ items, page: 3, pageSize: 100 }),
    ).toHaveLength(5);
    expect(getHistoryTotalPages(items.length, 100)).toBe(3);
    expect(getHistoryTotalPages(items.length, "all")).toBe(1);
  });
});
