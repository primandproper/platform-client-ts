import { describe, expect, it } from 'vitest';

import type { Pagination, QueryFilter } from './generated/primandproper/platform/filtering/v1/filtering';
import { counts, items, type ListResponse, pages } from './pagination';

interface Request {
  filter: QueryFilter | undefined;
  parentId: string;
}

function pagination(cursor: string, overrides: Partial<Pagination> = {}): Pagination {
  return {
    appliedQueryFilter: undefined,
    cursor,
    previousCursor: '',
    filteredCount: 0,
    totalCount: 0,
    maxResponseSize: 2,
    countsKnown: false,
    ...overrides,
  };
}

/** server answers from `rows` two at a time, keyed on the last row's value, as a keyset store does. */
function server(rows: string[]) {
  const requests: Request[] = [];
  const fetch = (request: Request): Promise<ListResponse<string>> => {
    requests.push(request);
    const after = request.filter?.cursor ? rows.indexOf(request.filter.cursor) + 1 : 0;
    const results = rows.slice(after, after + 2);
    return Promise.resolve({ results, pagination: pagination(results.at(-1) ?? '') });
  };
  return { fetch, requests };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) {
    out.push(v);
  }
  return out;
}

describe('pages', () => {
  it('walks to the first page with no rows, passing each cursor back unchanged', async () => {
    const { fetch, requests } = server(['a', 'b', 'c', 'd', 'e']);

    const walked = await collect(pages(fetch, { filter: filter({ sortBy: 'desc' }), parentId: 'p' }));

    expect(walked.map((p) => p.results)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(requests.map((r) => r.filter?.cursor)).toEqual([undefined, 'b', 'd', 'e']);
    expect(requests.every((r) => r.parentId === 'p' && r.filter?.sortBy === 'desc')).toBe(true);
  });

  it('does not stop on a short page', async () => {
    const rows = ['a', 'b', 'c'];
    const requests: Request[] = [];
    const fetch = (request: Request): Promise<ListResponse<string>> => {
      requests.push(request);
      // A server whose pages come back short before the end: one row where two were allowed.
      const after = request.filter?.cursor ? rows.indexOf(request.filter.cursor) + 1 : 0;
      const results = rows.slice(after, after + 1);
      return Promise.resolve({ results, pagination: pagination(results.at(-1) ?? '') });
    };

    const walked = await collect(items(fetch, { filter: undefined, parentId: 'p' }));

    expect(walked).toEqual(['a', 'b', 'c']);
    expect(requests).toHaveLength(4);
  });

  it('starts from the cursor the request already carries', async () => {
    const { fetch } = server(['a', 'b', 'c', 'd']);

    const walked = await collect(items(fetch, { filter: filter({ cursor: 'b' }), parentId: 'p' }));

    expect(walked).toEqual(['c', 'd']);
  });

  it('yields nothing for an empty list, after one round trip', async () => {
    const { fetch, requests } = server([]);

    expect(await collect(pages(fetch, { filter: undefined, parentId: 'p' }))).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('refuses a page with rows and no cursor rather than restarting the list', async () => {
    const fetch = (): Promise<ListResponse<string>> => Promise.resolve({ results: ['a'], pagination: pagination('') });

    await expect(collect(pages(fetch, { filter: undefined, parentId: 'p' }))).rejects.toThrow('no cursor');
  });

  it('refuses a page that hands back the cursor that reached it', async () => {
    const fetch = (): Promise<ListResponse<string>> => Promise.resolve({ results: ['a'], pagination: pagination('a') });
    const walker = pages(fetch, { filter: filter({ cursor: 'a' }), parentId: 'p' });

    await expect(collect(walker)).rejects.toThrow('repeat it forever');
  });

  it('does not change the request it was given', async () => {
    const { fetch } = server(['a', 'b', 'c']);
    const request: Request = { filter: undefined, parentId: 'p' };

    await collect(pages(fetch, request));

    expect(request).toEqual({ filter: undefined, parentId: 'p' });
  });
});

describe('counts', () => {
  it('answers the counts when the page vouches for them', () => {
    expect(counts(pagination('a', { countsKnown: true, filteredCount: 3, totalCount: 10 }))).toEqual({
      filtered: 3,
      total: 10,
    });
  });

  it('answers undefined rather than zero when counts are not known (R9)', () => {
    expect(counts(pagination('', { countsKnown: false, filteredCount: 0, totalCount: 0 }))).toBeUndefined();
  });

  it('answers undefined for a response with no pagination', () => {
    expect(counts(undefined)).toBeUndefined();
  });

  it('reports a known zero as zero', () => {
    expect(counts(pagination('', { countsKnown: true }))).toEqual({ filtered: 0, total: 0 });
  });
});

function filter(overrides: Partial<QueryFilter>): QueryFilter {
  return {
    createdAfter: undefined,
    createdBefore: undefined,
    updatedAfter: undefined,
    updatedBefore: undefined,
    ...overrides,
  };
}
