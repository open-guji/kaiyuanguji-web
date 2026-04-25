/**
 * Catch-all API route for local book-index data access.
 * Only works during `next dev` (not compatible with `output: 'export'` build).
 *
 * Routes:
 *   GET /api/book-index/entry/:id
 *   GET /api/book-index/item/:id
 *   GET /api/book-index/all-entries?type=book
 *   GET /api/book-index/entries?type=book&page=1&pageSize=50&sortBy=title&sortOrder=asc
 *   GET /api/book-index/search?q=xxx&type=book&page=1&pageSize=50
 *   GET /api/book-index/search-all?q=xxx&limit=5
 *   GET /api/book-index/catalog/:id
 *   GET /api/book-index/collated/:id
 *   GET /api/book-index/collated/:id/:juanFile
 *   GET /api/book-index/work-catalog/:id
 *   GET /api/book-index/resource-progress
 *   GET /api/book-index/resource-site-progress
 *   GET /api/book-index/resource-counts
 *   GET /api/book-index/recommended
 */

import { NextRequest, NextResponse } from 'next/server';
import * as localData from '@/lib/local-data';

function json(data: unknown, status = 200) {
    return NextResponse.json(data, { status });
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string[] }> },
) {
    const { slug } = await params;
    const action = slug[0];
    const searchParams = request.nextUrl.searchParams;

    switch (action) {
        case 'entry': {
            const id = slug[1];
            if (!id) return json({ error: 'Missing id' }, 400);
            const entry = localData.getEntry(decodeURIComponent(id));
            if (!entry) return json({ error: 'Not found' }, 404);
            return json(entry);
        }

        case 'item': {
            const id = slug[1];
            if (!id) return json({ error: 'Missing id' }, 400);
            const item = localData.getItem(decodeURIComponent(id));
            if (!item) return json({ error: 'Not found' }, 404);
            return json(item);
        }

        case 'all-entries': {
            const type = searchParams.get('type') || 'book';
            const entries = localData.getAllEntries(type);
            return json(entries);
        }

        case 'entries': {
            const type = searchParams.get('type') || 'book';
            const page = parseInt(searchParams.get('page') || '1');
            const pageSize = parseInt(searchParams.get('pageSize') || '50');
            const sortBy = searchParams.get('sortBy') || 'title';
            const sortOrder = searchParams.get('sortOrder') || 'asc';

            let entries = localData.getAllEntries(type);
            entries.sort((a, b) => {
                const va = String((a as Record<string, unknown>)[sortBy] ?? '');
                const vb = String((b as Record<string, unknown>)[sortBy] ?? '');
                const cmp = va.localeCompare(vb, 'zh');
                return sortOrder === 'asc' ? cmp : -cmp;
            });

            const total = entries.length;
            const start = (page - 1) * pageSize;
            return json({ entries: entries.slice(start, start + pageSize), total, page, pageSize });
        }

        case 'search': {
            const q = searchParams.get('q') || '';
            const type = searchParams.get('type') || 'book';
            const page = parseInt(searchParams.get('page') || '1');
            const pageSize = parseInt(searchParams.get('pageSize') || '50');
            const result = await localData.searchEntries(q, type, page, pageSize);
            return json(result);
        }

        case 'search-all': {
            const q = searchParams.get('q') || '';
            const limit = parseInt(searchParams.get('limit') || '5');
            const result = await localData.searchAll(q, limit);
            return json(result);
        }

        case 'catalog': {
            const id = slug[1];
            if (!id) return json({ error: 'Missing id' }, 400);
            const catalogs = localData.getCollectionCatalogs(decodeURIComponent(id));
            if (!catalogs) return json({ error: 'Not found' }, 404);
            return json(catalogs);
        }

        case 'collated': {
            const id = slug[1];
            if (!id) return json({ error: 'Missing id' }, 400);
            const juanFile = slug[2];

            if (juanFile) {
                const juan = localData.getCollatedJuan(
                    decodeURIComponent(id),
                    decodeURIComponent(juanFile),
                );
                if (!juan) return json({ error: 'Not found' }, 404);
                return json(juan);
            }

            const index = localData.getCollatedEditionIndex(decodeURIComponent(id));
            if (!index) return json({ error: 'Not found' }, 404);
            return json(index);
        }

        case 'work-catalog': {
            const id = slug[1];
            if (!id) return json({ error: 'Missing id' }, 400);
            const catalogs = localData.getWorkCatalog(decodeURIComponent(id));
            if (!catalogs) return json({ error: 'Not found' }, 404);
            return json(catalogs);
        }

        case 'resource-progress': {
            const data = localData.getResourceProgress();
            if (!data) return json({ error: 'Not found' }, 404);
            return json(data);
        }

        case 'resource-site-progress': {
            const data = localData.getSiteProgress();
            if (!data) return json({ error: 'Not found' }, 404);
            return json(data);
        }

        case 'resource-counts': {
            return json(localData.getResourceCounts());
        }

        case 'recommended': {
            const data = localData.getRecommended();
            if (!data) return json({ error: 'Not found' }, 404);
            return json(data);
        }

        default:
            return json({ error: 'Unknown endpoint' }, 404);
    }
}
