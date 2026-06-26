import { Test } from '@nestjs/testing';
import { MarketingOutboundService } from './marketing-outbound.service';
import { PrismaService } from '../prisma/prisma.service';

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
      return { ok: true, status: 200 } as any;
    }) as any;
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: 'ws-1', externalTenantId: 'hjz-tenant-1' }) },
      segment: { findFirst: jest.fn().mockResolvedValue({
        id: 'crm-seg-1', name: 'Replied', filter: '{}', origin: 'crm', workspaceId: 'ws-1',
      }) },
      contact: { findMany: jest.fn().mockResolvedValue([
        { externalId: 'c-a' }, { externalId: 'c-b' },
      ]) },
    };
    const mod = await Test.createTestingModule({
      providers: [
        MarketingOutboundService,
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
});
