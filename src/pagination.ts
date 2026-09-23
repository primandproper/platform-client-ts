import type { Pagination, QueryFilter } from './generated/primandproper/platform/filtering/v1/filtering';

/** ListRequest is the shape every list RPC's request shares. */
export interface ListRequest {
  filter: QueryFilter | undefined;
}

/** ListResponse is the shape every list RPC's response shares. */
export interface ListResponse<T> {
  pagination: Pagination | undefined;
  results: T[];
}

/**
 * pages walks a list from `request`'s cursor (or the start) to its end, yielding each page that held rows. `fetch` is
 * one call of the list RPC, typically `(req) => session.call(Service.listThings, req)`.
 *
 * It ends on a page with no rows and nowhere else (R14). A page shorter than `max_response_size` is not the end, since
 * nothing promises that, and stopping on one silently truncates the list. Reaching the end therefore costs one extra
 * round trip, which is the shape of a keyset walk. Cursors are passed back exactly as they came (R8).
 */
export async function* pages<Req extends ListRequest, Res extends ListResponse<unknown>>(
  fetch: (request: Req) => Promise<Res>,
  request: Req,
): AsyncGenerator<Res, void, undefined> {
  let cursor = request.filter?.cursor;
  for (;;) {
    const page = await fetch({ ...request, filter: { ...emptyFilter, ...request.filter, cursor } });
    if (page.results.length === 0) {
      return;
    }
    const next = page.pagination?.cursor;
    if (!next) {
      throw new Error('a page held rows and no cursor to the next one; walking on would restart the list');
    }
    if (next === cursor) {
      throw new Error('a page answered with the cursor that reached it; walking on would repeat it forever');
    }
    yield page;
    cursor = next;
  }
}

/** items walks a list like `pages`, yielding its rows one at a time. */
export async function* items<Req extends ListRequest, T>(
  fetch: (request: Req) => Promise<ListResponse<T>>,
  request: Req,
): AsyncGenerator<T, void, undefined> {
  for await (const page of pages(fetch, request)) {
    yield* page.results;
  }
}

export interface Counts {
  /** filtered is how many rows in the collection match the filter. */
  filtered: number;
  /** total is how many rows the collection holds. */
  total: number;
}

/**
 * counts reads a page's counts, or answers undefined when the page does not vouch for them (R9). A store that reads
 * counts off its rows has none to read on an empty page, so a zero there is not a result, and `counts_known` is what
 * tells the two apart. When known, both describe the collection the page was cut from, not the page.
 */
export function counts(pagination: Pagination | undefined): Counts | undefined {
  if (!pagination?.countsKnown) {
    return undefined;
  }
  return { filtered: pagination.filteredCount, total: pagination.totalCount };
}

const emptyFilter: QueryFilter = {
  createdAfter: undefined,
  createdBefore: undefined,
  updatedAfter: undefined,
  updatedBefore: undefined,
};
