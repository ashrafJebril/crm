import { BadRequestException } from '@nestjs/common';
import { ADS_PROMPTS, ADS_TIPS, resolveUserMessage } from './ads-prompt-catalog';
import { AdsPromptNotAvailableException } from './ads.exceptions';
import type { PostAdsChatRequest } from './ads.types';

function req(overrides: Partial<PostAdsChatRequest>): PostAdsChatRequest {
  return { locale: 'ar', ...overrides } as PostAdsChatRequest;
}

describe('ADS_PROMPTS catalog integrity', () => {
  it('has all 38 entries', () => {
    expect(ADS_PROMPTS.length).toBe(38);
  });

  it('has exactly 28 active entries', () => {
    expect(ADS_PROMPTS.filter((p) => p.status === 'active').length).toBe(28);
  });

  it('has 3 tips', () => {
    expect(ADS_TIPS.length).toBe(3);
  });
});

describe('resolveUserMessage', () => {
  it('throws BadRequestException for an unknown promptId', () => {
    expect(() => resolveUserMessage(req({ promptId: 'not_a_real_prompt' }))).toThrow(BadRequestException);
  });

  it('throws AdsPromptNotAvailableException for a coming_soon promptId', () => {
    const comingSoon = ADS_PROMPTS.find((p) => p.status === 'coming_soon');
    expect(comingSoon).toBeDefined();
    expect(() => resolveUserMessage(req({ promptId: comingSoon!.id }))).toThrow(
      AdsPromptNotAvailableException,
    );
  });

  it('returns the Arabic prompt text for an active promptId when locale is ar', () => {
    const active = ADS_PROMPTS.find((p) => p.status === 'active')!;
    expect(resolveUserMessage(req({ promptId: active.id, locale: 'ar' }))).toBe(active.promptAr);
  });

  it('returns the English prompt text for an active promptId when locale is en', () => {
    const active = ADS_PROMPTS.find((p) => p.status === 'active')!;
    expect(resolveUserMessage(req({ promptId: active.id, locale: 'en' }))).toBe(active.promptEn);
  });

  it('throws BadRequestException when neither message nor promptId is given', () => {
    expect(() => resolveUserMessage(req({}))).toThrow(BadRequestException);
  });
});
