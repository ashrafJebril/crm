import { Test } from '@nestjs/testing';
import { MarketingOutboundService } from './marketing-outbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { SegmentsService } from './segments.service';

describe('MarketingOutboundService', () => {
  const realFetch = global.fetch;
  let svc: MarketingOutboundService;
  let prisma: any;
  let calls: any[];

  beforeEach(async () => {
    process.env.HJZ_OUTBOUND_URL = 'http://test.local/api/v1/webhooks/marketing/segments';
    process.env.HJZ_WEBHOOK_SECRET = 'shared-secret';
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({}) } as any;
    }) as any;
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: 'ws-1', externalTenantId: 'hjz-tenant-1' }) },
      segment: { findFirst: jest.fn().mockResolvedValue({
        id: 'crm-seg-1', name: 'Replied', filter: '{}', origin: 'crm', workspaceId: 'ws-1',
      }) },
      contact: { findMany: jest.fn().mockResolvedValue([
        { hjzClientId: 'c-a' }, { hjzClientId: 'c-b' },
      ]) },
    };
    const mod = await Test.createTestingModule({
      providers: [
        MarketingOutboundService,
        SegmentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = mod.get(MarketingOutboundService);
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.HJZ_OUTBOUND_URL;
    delete process.env.HJZ_WEBHOOK_SECRET;
  });

  it('emitSegmentUpserted POSTs segment.upserted with hjzClientIds', async () => {
    const ok = await svc.emitSegmentUpserted('ws-1', 'crm-seg-1');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.event).toBe('segment.upserted');
    expect(calls[0].body.segment.tenantId).toBe('hjz-tenant-1');
    expect(calls[0].body.segment.hjzClientIds).toEqual(['c-a', 'c-b']);
    expect(calls[0].headers['x-marketing-secret']).toBe('shared-secret');
    expect(calls[0].url).toBe('http://test.local/api/v1/webhooks/marketing/segments');
  });

  it('applies tag filters and only sends contacts linked to an hjz client', async () => {
    prisma.segment.findFirst.mockResolvedValue({
      id: 'crm-seg-1', name: 'VIP', filter: JSON.stringify({ tagsAny: ['VIP'] }), origin: 'crm', workspaceId: 'ws-1',
    });
    await svc.emitSegmentUpserted('ws-1', 'crm-seg-1');
    const where = prisma.contact.findMany.mock.calls[0][0].where;
    expect(where.AND[0].AND).toEqual([{ OR: [{ tags: { contains: '"VIP"' } }] }]);
    expect(where.AND[1]).toEqual({ hjzClientId: { not: null } });
  });

  it('pushes manual groups by membership', async () => {
    prisma.segment.findFirst.mockResolvedValue({
      id: 'grp-1', name: 'Hand-picked', filter: '{}', origin: 'manual', workspaceId: 'ws-1',
    });
    const ok = await svc.emitSegmentUpserted('ws-1', 'grp-1');
    expect(ok).toBe(true);
    const where = prisma.contact.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ workspaceId: 'ws-1', segmentMembers: { some: { segmentId: 'grp-1' } } });
  });

  it('posts to HJZ_API_URL when set', async () => {
    process.env.HJZ_API_URL = 'http://hjz.local/api/v1/';
    try {
      await svc.emitSegmentUpserted('ws-1', 'crm-seg-1');
      expect(calls[0].url).toBe('http://hjz.local/api/v1/webhooks/marketing/segments');
    } finally {
      delete process.env.HJZ_API_URL;
    }
  });

  it('emitSegmentDeleted POSTs segment.deleted', async () => {
    await svc.emitSegmentDeleted('ws-1', 'crm-seg-1');
    expect(calls[0].body.event).toBe('segment.deleted');
    expect(calls[0].body.segment).toEqual({ id: 'crm-seg-1', tenantId: 'hjz-tenant-1' });
  });

  it('returns false (no-op) when env unset', async () => {
    delete process.env.HJZ_OUTBOUND_URL;
    const ok = await svc.emitSegmentUpserted('ws-1', 'crm-seg-1');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('skips and returns false when segment origin is not crm', async () => {
    prisma.segment.findFirst.mockResolvedValueOnce({
      id: 'hjz-mirror-1',
      name: 'Loyal',
      filter: '{}',
      origin: 'hjz',
      workspaceId: 'ws-1',
    });
    const ok = await svc.emitSegmentUpserted('ws-1', 'hjz-mirror-1');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('emitSegmentDeleted skips when segment origin is hjz', async () => {
    prisma.segment.findFirst.mockResolvedValueOnce({
      id: 'hjz-mirror-1',
      origin: 'hjz',
      workspaceId: 'ws-1',
    });
    const ok = await svc.emitSegmentDeleted('ws-1', 'hjz-mirror-1');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
