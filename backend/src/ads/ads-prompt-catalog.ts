import { BadRequestException } from '@nestjs/common';
import type { AdsPromptEntry, AdsTip, PostAdsChatRequest } from './ads.types';
import { AdsPromptNotAvailableException } from './ads.exceptions';

/**
 * Kewy Marketing Ads Assistant — server-side prompt catalog (single source of truth).
 *
 * ⚠️ IDS ARE A PERMANENT CONTRACT. Each entry.id is sent by the web as promptId
 * and referenced from chat history/telemetry from day one. NEVER rename an id —
 * only ADD new ones or flip `status`. Renaming silently breaks those references.
 *
 * Entries are written NATIVELY in ar + en (not translations); Arabic is feminine
 * 2nd-person (women-only salon). Rules baked into the prompt text:
 *  - CURRENCY: never hardcode $/JOD — say "the account currency" and let the
 *    assistant read it from the currency field on the get_insights result (this
 *    account is USD today; another tenant may use a different currency).
 *  - NORTH-STAR: cost per CONVERSATION (chatsStarted) is the primary denominator
 *    for this account (messaging objective). leads/purchases are secondary,
 *    reported SEPARATELY, never added to conversations.
 *  - BUDGETS: campaign budgets are often null (they live at ad-set level, which
 *    we can't read) — reallocation prompts recommend in PROPORTIONS of actual
 *    spend when exact budgets aren't available, not absolute amounts.
 *  - ROW CAP (200 rows, ads-chat.service.ts):
 *      1. hourly/fine breakdowns: ACCOUNT or CAMPAIGN level only — never ad level.
 *      2. hourly window: 30d, not 7d (too small a sample per bucket).
 *      3. never combine a fine breakdown with a long daily series (~720 blow-up).
 *  - status 'active' = executable TODAY with get_ad_accounts / get_campaigns /
 *    get_insights (post A0+A0b+A0c). 'coming_soon' + blockedBy[] otherwise.
 */
export const ADS_PROMPTS: AdsPromptEntry[] = [
  // ── ANALYSIS (7) ──────────────────────────────────────────────────────────
  {
    id: 'top_bottom_ads', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Top & Bottom Performers', titleAr: 'الأفضل والأسوأ أداءً',
    descEn: "Your best and worst 5 ads by cost per conversation, and why", descAr: 'أفضل ٥ وأسوأ ٥ إعلانات حسب تكلفة المحادثة، وسبب تفوّقها أو ضعفها',
    promptEn: "Show me my 5 best and 5 worst performing ads this month by cost per conversation. For each, include CTR, CPC, spend, and reach in the account currency. What do the top performers share, and what's dragging the bottom ones down?",
    promptAr: 'وريني أفضل 5 وأسوأ 5 إعلانات هالشهر حسب تكلفة المحادثة الواحدة. لكل إعلان اعرضي الـCTR والـCPC والصرف والوصول بعملة الحساب. شو المشترك بين الأفضل، وشو السبب اللي بيرجّع الأضعف لتحت؟',
  },
  {
    id: 'campaign_audit', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Campaign Audit', titleAr: 'تدقيق الحملات',
    descEn: "Which campaigns overspend for weak results, ranked by efficiency", descAr: 'الحملات اللي بتصرف كثير وترجّع نتائج ضعيفة، مرتّبة حسب الكفاءة',
    promptEn: "Audit my active campaigns: which spend the most for the weakest results (spend vs conversations started)? Rank them by cost per conversation and flag the inefficient ones. Suggest how to shift budget — in proportions of current spend if exact budgets aren't readable — and report leads and purchases separately.",
    promptAr: 'دقّقي بحملاتي الشغّالة: مين عم تصرف أكثر وترجّع أضعف نتائج (الصرف مقابل المحادثات)؟ رتّبيهن حسب تكلفة المحادثة وحدّدي غير الفعّالة. اقترحي كيف أوزّع الميزانية — بنِسَب من الصرف الحالي إذا الميزانيات الدقيقة مش قابلة للقراءة — واعرضي الليدز والمبيعات لحالهن.',
  },
  {
    id: 'weekly_summary', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Weekly Performance Summary', titleAr: 'ملخّص الأسبوع',
    descEn: "This week vs last week at a glance, with the big changes flagged", descAr: 'هالأسبوع مقابل الأسبوع الماضي، مع تمييز التغيّرات الكبيرة',
    promptEn: 'Summarize this week vs last week at the account level: spend, conversations started, cost per conversation, CTR, CPC. Highlight any change bigger than 20% and flag what needs my attention now.',
    promptAr: 'لخّصيلي هالأسبوع مقابل الأسبوع الماضي على مستوى الحساب: الصرف، المحادثات، تكلفة المحادثة، الـCTR، الـCPC. ميّزي أي تغيّر أكبر من 20% وحدّديلي شو بدّه انتباه هلق.',
  },
  {
    id: 'cost_per_result_breakdown', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Cost per Result Breakdown', titleAr: 'تكلفة كل نتيجة',
    descEn: "What a conversation costs per campaign, cheapest to priciest", descAr: 'قدّيش بتكلّف المحادثة بكل حملة، من الأرخص للأغلى',
    promptEn: 'What does a conversation cost me across my campaigns? Rank them cheapest to most expensive by cost per conversation (account currency). Show cost per lead and cost per booking separately where they exist — never merged. Which campaigns deserve more budget?',
    promptAr: 'قدّيش بتكلّفني المحادثة الوحدة بكل حملة؟ رتّبي حملاتي من الأرخص للأغلى حسب تكلفة المحادثة (بعملة الحساب). اعرضي تكلفة الليد وتكلفة الحجز لحالهن إذا وُجدت — من دون ما تجمعيهن. أي حملات بتستاهل ميزانية أكثر؟',
  },
  {
    id: 'efficiency_deep_dive', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Efficiency Deep Dive', titleAr: 'تحليل الكفاءة',
    descEn: "Every campaign vs your account average, plus savings from pausing", descAr: 'كل حملة مقارنة بمعدّل حسابك، وكم توفّر لو وقّفت الأضعف',
    promptEn: 'Deep-dive my campaign efficiency: rank every campaign by cost per conversation against the account average. Which are well below average (efficient) and which are far above (wasting spend)? Estimate how much I would save this month by pausing the worst ones.',
    promptAr: 'غوصي بكفاءة حملاتي: رتّبي كل حملة حسب تكلفة المحادثة مقارنة بمعدّل الحساب. مين تحت المعدّل بكثير (فعّالة) ومين فوقه بكثير (بتهدر صرف)؟ قدّريلي قدّيش رح أوفّر هالشهر إذا وقّفت الأسوأ.',
  },
  {
    id: 'daily_snapshot', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Daily Performance Snapshot', titleAr: 'لقطة اليوم',
    descEn: "Today vs yesterday at a glance, with anything unusual flagged", descAr: 'اليوم مقابل مبارح بلمحة، مع تنبيه لأي شي غير طبيعي',
    promptEn: 'Give me a quick snapshot of today vs yesterday: spend, impressions, conversations started, cost per conversation, and CTR. Flag anything unusual I should look at.',
    promptAr: 'أعطيني لقطة سريعة لليوم مقابل مبارح: الصرف، الظهور، المحادثات، تكلفة المحادثة، والـCTR. نبّهيني على أي شي غريب لازم دقّق عليه.',
  },
  {
    id: 'monthly_report', category: 'analysis', status: 'active', blockedBy: [],
    titleEn: 'Monthly Performance Report', titleAr: 'التقرير الشهري',
    descEn: "A full month report: totals, best/worst campaigns, and next steps", descAr: 'تقرير شهري كامل: الإجماليات، أفضل وأسوأ الحملات، وخطوات جاية',
    promptEn: 'Build a monthly report at the account level: total spend, conversations started, average cost per conversation, my 3 best and 3 worst campaigns by cost per conversation, month-over-month trend, and 3 recommendations for next month. Report leads and bookings separately.',
    promptAr: 'جهّزيلي تقرير شهري على مستوى الحساب: إجمالي الصرف، المحادثات، متوسط تكلفة المحادثة، أفضل 3 وأسوأ 3 حملات حسب تكلفة المحادثة، الاتجاه مقارنة بالشهر الماضي، و3 توصيات للشهر الجاي. اعرضي الليدز والحجوزات لحالهن.',
  },

  // ── OPTIMIZATION (7) ──────────────────────────────────────────────────────
  {
    id: 'budget_optimization', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'Budget Optimization', titleAr: 'توزيع الميزانية',
    descEn: "How to shift spend across campaigns to get more conversations", descAr: 'كيف توزّع الصرف بين الحملات لتجيب محادثات أكثر',
    promptEn: "Look at how my budget is spread across campaigns and how each performs on cost per conversation. How should I redistribute spend to get more conversations for the same money? Give shifts in the account currency, or in proportions of current spend if exact budgets aren't readable.",
    promptAr: 'شوفي كيف موزّعة ميزانيتي على الحملات وكيف أداء كل وحدة على تكلفة المحادثة. كيف الأفضل أعيد توزيع الصرف لجيب محادثات أكثر بنفس المصاري؟ أعطيني التعديلات بعملة الحساب، أو بنِسَب من الصرف الحالي إذا الميزانيات الدقيقة مش قابلة للقراءة.',
  },
  {
    id: 'fix_underperforming_ads', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'Fix Underperforming Ads', titleAr: 'إصلاح الإعلانات الضعيفة',
    descEn: "Your weak ads and whether to pause, refresh, retarget, or rebudget", descAr: 'إعلاناتك الضعيفة، وهل توقّفها أو تجدّدها أو تعدّل استهدافها',
    promptEn: 'Find my underperforming ads — CTR under 1%, or cost per conversation above the account average. For each, tell me the likely problem from the numbers and whether to pause it, refresh the creative, adjust targeting, or change budget.',
    promptAr: 'لاقيلي الإعلانات الضعيفة — CTR أقل من 1%، أو تكلفة محادثة أعلى من معدّل الحساب. لكل وحدة، قوليلي شو المشكلة المتوقّعة من الأرقام، وإذا الأفضل أوقّفها، أجدّد التصميم، أعدّل الاستهداف، أو أغيّر الميزانية.',
  },
  {
    id: 'scaling_strategy', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'Scaling Strategy', titleAr: 'خطة التوسّع',
    descEn: "Which campaigns are ready to scale, and by how much", descAr: 'أي حملات جاهزة للتكبير، وقدّيش تزيد ميزانيتها',
    promptEn: "Which campaigns are ready to scale? Look for low cost per conversation with room to grow — low frequency means the audience isn't saturated yet. Suggest specific budget increases and the conversations I could expect.",
    promptAr: 'أي حملات جاهزة أكبّرها؟ دوّري على تكلفة محادثة منخفضة مع مجال للنمو — التكرار المنخفض يعني الجمهور لسا مش مشبع. اقترحي زيادات ميزانية محدّدة وقدّيش محادثات ممكن أتوقّع.',
  },
  {
    id: 'ab_test_analysis', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'A/B Test Analysis', titleAr: 'تحليل اختبارات A/B',
    descEn: "Compare ads within each ad set — which win, which to cut", descAr: 'مقارنة الإعلانات جوّا كل مجموعة — مين يفوز ومين تشيل',
    promptEn: 'Within each ad set, compare my ads against each other by cost per conversation and CTR. Which are winning, and is there enough volume yet to trust the difference? Tell me which to keep and which to cut.',
    promptAr: 'جوّا كل مجموعة إعلانية، قارني إعلاناتي ببعض حسب تكلفة المحادثة والـCTR. مين عم يفوز، وهل في كمية كافية لنثق بالفرق؟ قوليلي مين أبقّي ومين أشيل.',
  },
  {
    id: 'what_to_pause', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'What to Pause', titleAr: 'شو أوقِّف؟',
    descEn: "Which campaigns to pause now, and what you'd save this month", descAr: 'أي حملات توقّفها هلق، وقدّيش توفّر هالشهر',
    promptEn: 'Review my active campaigns, ad sets, and ads. Which should I pause right now for weak cost per conversation, and how much would I save this month by pausing them? List them by name.',
    promptAr: 'راجعي حملاتي ومجموعاتي وإعلاناتي الشغّالة. مين لازم أوقّفه هلق بسبب تكلفة محادثة ضعيفة، وقدّيش رح أوفّر هالشهر إذا وقّفتهن؟ عدّديهن بالاسم.',
  },
  {
    id: 'quick_wins', category: 'optimization', status: 'active', blockedBy: [],
    titleEn: 'Quick Wins', titleAr: 'مكاسب سريعة',
    descEn: "3–5 quick changes to lower your cost per conversation now", descAr: '٣–٥ تغييرات سريعة تنزّل تكلفة المحادثة عندك هلق',
    promptEn: 'Give me 3–5 quick changes I can make right now to lower my cost per conversation — based on my placements, audiences, timing, and campaign spread. Keep them specific and high-impact.',
    promptAr: 'أعطيني 3–5 تغييرات سريعة أقدر أعملها هلق لأنزّل تكلفة المحادثة — بناءً على المواضع والجماهير والتوقيت وتوزيع الحملات. خلّيهن محدّدة وتأثيرهن كبير.',
  },
  {
    id: 'learning_phase_check', category: 'optimization', status: 'coming_soon', blockedBy: ['entity_tools'],
    titleEn: 'Learning Phase Check', titleAr: 'مرحلة التعلّم',
    descEn: "Which ad sets are still in the learning phase, and how they're doing", descAr: 'أي مجموعات لساتها بمرحلة التعلّم، وكيف أداؤها',
    promptEn: 'Which of my ad sets are still in the learning phase, how are they doing so far, and which look unlikely to exit learning successfully?',
    promptAr: 'أي مجموعات إعلانية لساتها بمرحلة التعلّم، كيف أداؤها لحد هلق، ومين مِنهن يبيّن إنه رح يصعب يطلع من التعلّم بنجاح؟',
  },

  // ── AUDIENCE (5) ──────────────────────────────────────────────────────────
  {
    id: 'audience_type_performance', category: 'audience', status: 'active', blockedBy: [],
    titleEn: 'Audience Performance', titleAr: 'أداء أنواع الجمهور',
    descEn: "Cost per conversation by audience type — custom, lookalike, broad", descAr: 'تكلفة المحادثة حسب نوع الجمهور — مخصّص، مشابه، واسع',
    promptEn: 'Break down performance by audience type — custom audiences, lookalikes, interest-based, and broad. Which type gives me the best cost per conversation?',
    promptAr: 'فصّليلي الأداء حسب نوع الجمهور — جماهير مخصّصة، مشابهة، حسب الاهتمامات، وواسعة. أي نوع بيعطيني أفضل تكلفة محادثة؟',
  },
  {
    id: 'demographic_insights', category: 'audience', status: 'active', blockedBy: [],
    titleEn: 'Demographic Insights', titleAr: 'الفئات والمناطق',
    descEn: "Which ages, genders, and places give your cheapest conversations", descAr: 'أي فئات عمرية وجنس ومناطق بتعطيك أرخص المحادثات',
    promptEn: "Which age groups, genders, and locations give me the best cost per conversation? Show the breakdown and any segment I'm underusing. Ignore segments with no spend or an 'Unknown' label except as a data-quality note.",
    promptAr: 'أي فئات عمرية وأي جنس وأي مناطق بتعطيني أفضل تكلفة محادثة؟ اعرضي التفصيل وأي شريحة مستغلّاها أقل من اللازم. تجاهلي الشرائح اللي بلا صرف أو المكتوب عندها "غير معروف" إلا كملاحظة عن جودة البيانات.',
  },
  {
    id: 'lookalike_recommendations', category: 'audience', status: 'coming_soon', blockedBy: ['creative_tools'],
    titleEn: 'Lookalike Recommendations', titleAr: 'جماهير مشابهة مقترحة',
    descEn: "Which lookalike audiences to create, and the best seeds for them", descAr: 'أي جماهير مشابهة تنشئها، وأفضل بذور تبنيها عليها',
    promptEn: 'Based on my best-performing audiences, which lookalike audiences should I create, and which source audiences would make the strongest seeds?',
    promptAr: 'بناءً على أفضل جماهيري أداءً، أي جماهير مشابهة (lookalike) الأفضل أنشئها، وأي جماهير مصدر بتكون أقوى بذرة؟',
  },
  {
    id: 'placement_performance', category: 'audience', status: 'active', blockedBy: [],
    titleEn: 'Placement Performance', titleAr: 'أداء المواضع',
    descEn: "Which placements convert best — Feed, Stories, Reels, Messenger", descAr: 'أي مواضع بتحوّل أحسن — الفيد، الستوري، الريلز، والماسنجر',
    promptEn: 'Compare performance by placement — Feed, Stories, Reels, Messenger, Audience Network. Which placements give me the best cost per conversation, and should I turn any off?',
    promptAr: 'قارني الأداء حسب الموضع — Feed، Stories، Reels، Messenger، Audience Network. أي مواضع بتعطيني أفضل تكلفة محادثة، وفي شي لازم أطفّيه؟',
  },
  {
    id: 'device_performance', category: 'audience', status: 'active', blockedBy: [],
    titleEn: 'Device Performance', titleAr: 'الأداء حسب الجهاز',
    descEn: "How mobile compares to desktop, and whether to shift budget", descAr: 'الموبايل مقابل الكمبيوتر، وهل تحوّل ميزانية بينهم',
    promptEn: 'How do my ads perform on mobile vs desktop? Compare CTR and cost per conversation, and tell me whether to adjust budgets by device.',
    promptAr: 'كيف أداء إعلاناتي على الموبايل مقابل الكمبيوتر؟ قارني الـCTR وتكلفة المحادثة، وقوليلي إذا لازم أعدّل الميزانيات حسب الجهاز.',
  },

  // ── CREATIVE (6) ──────────────────────────────────────────────────────────
  {
    id: 'creative_performance', category: 'creative', status: 'active', blockedBy: [],
    titleEn: 'Creative Performance', titleAr: 'أداء التصاميم',
    descEn: "Which images and videos perform best, and what they share", descAr: 'أي صور وفيديوهات بتشتغل أحسن، وشو المشترك بينها',
    promptEn: 'Analyze my ad creatives — which images and videos get the best engagement and conversations, and what visual patterns do the top ones share?',
    promptAr: 'حلّليلي تصاميم إعلاناتي — أي صور وفيديوهات بتجيب أفضل تفاعل ومحادثات، وشو الأنماط البصرية المشتركة بين الأفضل؟',
  },
  {
    id: 'ad_copy_analysis', category: 'creative', status: 'active', blockedBy: [],
    titleEn: 'Ad Copy Analysis', titleAr: 'تحليل النصوص',
    descEn: "Which headlines and messages drive the most conversations", descAr: 'أي عناوين ورسائل بتجيب أكثر محادثات',
    promptEn: 'Review my ad copy — which headlines and descriptions drive the most conversations, and what kind of messaging resonates best with my audience?',
    promptAr: 'راجعي نصوص إعلاناتي — أي عناوين وأوصاف بتجيب أكثر محادثات، وأي أسلوب رسائل بيوصل أكثر لجمهوري؟',
  },
  {
    id: 'ad_fatigue_detection', category: 'creative', status: 'active', blockedBy: [],
    titleEn: 'Ad Fatigue Detection', titleAr: 'تعب الإعلانات',
    descEn: "Which ads are wearing out and need a creative refresh", descAr: 'أي إعلانات بيّنت تعب وبدها تجديد تصميم',
    promptEn: 'Are any of my ads showing fatigue? Check for frequency above 5 and a falling CTR over the last few weeks. Which ads need a creative refresh, and how urgent is each?',
    promptAr: 'في إعلانات عندي بيّنت تعب؟ دقّقي على التكرار فوق 5 والـCTR اللي عم ينزل خلال آخر أسابيع. أي إعلانات بدها تجديد تصميم، وقدّيش كل وحدة مستعجلة؟',
  },
  {
    id: 'video_ad_analysis', category: 'creative', status: 'coming_soon', blockedBy: ['creative_tools'],
    titleEn: 'Video vs Image Ads', titleAr: 'فيديو مقابل صورة',
    descEn: "How your video ads compare to image ads on cost per conversation", descAr: 'كيف إعلانات الفيديو بتقارن مع الصور على تكلفة المحادثة',
    promptEn: 'Analyze my video ads — completion rates, average watch time, and engagement. How do they compare to my image ads on cost per conversation?',
    promptAr: 'حلّليلي إعلانات الفيديو — نِسَب الإكمال، متوسط وقت المشاهدة، والتفاعل. كيف بتقارن مع إعلانات الصور على تكلفة المحادثة؟',
  },
  {
    id: 'creative_format_comparison', category: 'creative', status: 'coming_soon', blockedBy: ['creative_tools'],
    titleEn: 'Creative Format Comparison', titleAr: 'مقارنة صيغ التصميم',
    descEn: "Which format works best — single image, video, carousel, collection", descAr: 'أي صيغة بتشتغل أحسن — صورة، فيديو، كاروسيل، مجموعة',
    promptEn: 'Compare my creative formats — single image, video, carousel, collection. Which format works best for my campaigns on cost per conversation?',
    promptAr: 'قارني صيغ التصاميم عندي — صورة مفردة، فيديو، كاروسيل، مجموعة. أي صيغة بتشتغل أحسن لحملاتي على تكلفة المحادثة؟',
  },
  {
    id: 'creative_testing_status', category: 'creative', status: 'coming_soon', blockedBy: ['creative_tools'],
    titleEn: 'Creative Testing Status', titleAr: 'حالة اختبار التصاميم',
    descEn: "Which creative tests are winning, and what to test next", descAr: 'أي اختبارات تصاميم عم تفوز، وشو تختبر بعدين',
    promptEn: "Review my active creative tests — which variations are winning, is there enough data to be sure, and what should I test next based on what I've learned?",
    promptAr: 'راجعي اختبارات التصاميم الشغّالة — أي نسخ عم تفوز، هل في بيانات كافية للتأكيد، وشو الأفضل أختبر بعدين بناءً على اللي تعلّمته؟',
  },

  // ── CREATE (5) — all write_path ───────────────────────────────────────────
  {
    id: 'create_campaign', category: 'create', status: 'active', blockedBy: [],
    titleEn: 'New Campaign Setup', titleAr: 'إنشاء حملة',
    descEn: "Set up a new conversation campaign — created paused for approval", descAr: 'تجهيز حملة محادثات جديدة — تتنشأ متوقّفة لموافقتك',
    promptEn: "Help me set up a new conversation campaign. Tell me which service or offer you want to promote, and I'll recommend the objective, targeting, budget, placements, and ad format from your history. It's created paused for your approval.",
    promptAr: 'ساعديني أجهّز حملة محادثات جديدة. قوليلي أي خدمة أو عرض بدّك تروّجي، ورح أوصّيكِ بالهدف والاستهداف والميزانية والمواضع وشكل الإعلان بناءً على تاريخك. رح تتنشأ متوقّفة لموافقتك.',
  },
  {
    id: 'create_carousel_ad', category: 'create', status: 'coming_soon', blockedBy: ['write_path'],
    titleEn: 'Carousel Ad Creation', titleAr: 'إنشاء إعلان كاروسيل',
    descEn: "Build a carousel ad with suggested headlines and descriptions", descAr: 'بناء إعلان كاروسيل مع عناوين وأوصاف مقترحة',
    promptEn: "Help me build a carousel ad. Tell me the service and share the image links, and I'll suggest a headline (max 40 characters) and description (max 20 characters) for each of 4–6 cards. It's created paused for your review.",
    promptAr: 'ساعديني أعمل إعلان كاروسيل. قوليلي الخدمة وابعتيلي روابط الصور، ورح اقترحلك عنوان (بحد أقصى 40 حرف) ووصف (بحد أقصى 20 حرف) لكل بطاقة من 4 لـ6 بطاقات. رح يتنشأ متوقّف لمراجعتك.',
  },
  {
    id: 'create_retargeting_campaign', category: 'create', status: 'coming_soon', blockedBy: ['write_path', 'creative_tools'],
    titleEn: 'Retargeting Campaign', titleAr: 'حملة إعادة استهداف',
    descEn: "Re-reach people who engaged but didn't book yet", descAr: 'إعادة الوصول لَلّي تفاعلوا بس ما حجزوا',
    promptEn: "Set up a retargeting campaign for people who engaged but didn't book. I'll suggest audience windows (7, 14, 30 days), messaging angles, and the conversations to expect from similar past campaigns. Created paused for your approval.",
    promptAr: 'جهّزيلي حملة استهداف لإعادة الوصول لَلّي تفاعلوا بس ما حجزوا. رح اقترح فترات الجمهور (7، 14، 30 يوم) وزوايا الرسائل والمحادثات المتوقّعة من حملات سابقة مشابهة. تتنشأ متوقّفة لموافقتك.',
  },
  {
    id: 'create_lead_gen_campaign', category: 'create', status: 'coming_soon', blockedBy: ['write_path'],
    titleEn: 'Lead Generation Campaign', titleAr: 'حملة جمع ليدز',
    descEn: "Create a lead-gen campaign with form fields and targeting", descAr: 'إنشاء حملة جمع ليدز بحقول نموذج واستهداف',
    promptEn: "Help me create a lead-generation campaign. Tell me the service and I'll recommend the form fields, targeting, and creative approach, plus which lead magnets tend to work for salons. Created paused for your approval.",
    promptAr: 'ساعديني أنشئ حملة جمع ليدز. قوليلي الخدمة ورح أوصّي بحقول النموذج والاستهداف وأسلوب التصميم، وأي عروض جذب بتنفع للصالونات. تتنشأ متوقّفة لموافقتك.',
  },
  {
    id: 'create_brand_awareness_campaign', category: 'create', status: 'active', blockedBy: [],
    titleEn: 'Brand Awareness Campaign', titleAr: 'حملة وعي بالعلامة',
    descEn: "Reach new audiences and measure success by reach and frequency", descAr: 'الوصول لجماهير جديدة وقياس النجاح بالوصول والتكرار',
    promptEn: "Help me set up a brand-awareness campaign to reach new audiences. I'll suggest targeting, placements, and a creative approach, and how to measure success by reach and frequency. Created paused for your approval.",
    promptAr: 'ساعديني أجهّز حملة وعي بالعلامة لأوصل لجماهير جديدة. رح اقترح الاستهداف والمواضع وأسلوب التصميم، وكيف نقيس النجاح بالوصول والتكرار. تتنشأ متوقّفة لموافقتك.',
  },

  // ── BULK OPS (4) — all write_path ─────────────────────────────────────────
  {
    id: 'bulk_pause_underperformers', category: 'bulk_ops', status: 'active', blockedBy: [],
    titleEn: 'Bulk Pause Underperformers', titleAr: 'إيقاف جماعي للضعيفة',
    descEn: "Pause every weak ad at once — shown for your confirmation first", descAr: 'إيقاف كل الإعلانات الضعيفة دفعة وحدة — بعد تأكيدك',
    promptEn: 'Find every ad with CTR below 0.5% and cost per conversation above twice my account average, and pause them together. Show me the full list first — nothing changes until you confirm.',
    promptAr: 'لاقي كل إعلان الـCTR تبعه تحت 0.5% وتكلفة المحادثة فوق ضعف معدّل الحساب، ووقّفيهن سوا. وريني القائمة كاملة الأول — ما بيتغيّر إشي لحد ما توافقي.',
  },
  {
    id: 'bulk_budget_increase', category: 'bulk_ops', status: 'coming_soon', blockedBy: ['write_path'],
    titleEn: 'Bulk Budget Increase', titleAr: 'زيادة ميزانية جماعية',
    descEn: "Raise budgets on your efficient campaigns — after you confirm", descAr: 'زيادة ميزانية الحملات الفعّالة — بعد ما توافق',
    promptEn: 'Raise the daily budget by 20% on every campaign with a cost per conversation better than my account average and a meaningful amount of spend (account currency). Show me exactly what would change first — apply only after you confirm.',
    promptAr: 'زيدي الميزانية اليومية 20% لكل حملة تكلفة محادثتها أحسن من معدّل الحساب وعندها صرف معتبر (بعملة الحساب). وريني بالضبط شو رح يتغيّر الأول — ما تطبّقي إلا بعد ما توافقي.',
  },
  {
    id: 'bulk_activate_ads', category: 'bulk_ops', status: 'active', blockedBy: [],
    titleEn: 'Bulk Activate Ads', titleAr: 'تفعيل إعلانات جماعي',
    descEn: "Reactivate paused ads with strong CTR — after you confirm", descAr: 'إعادة تشغيل إعلانات متوقّفة نسبة النقر عندها قوية — بعد تأكيدك',
    promptEn: 'I want to reactivate paused ads with a CTR above 1% in one of my campaigns. Show me my campaigns so I can pick, then list the ads first — they activate only after I confirm.',
    promptAr: 'بدي أعيد تشغيل إعلانات متوقّفة الـCTR تبعها فوق 1% بوحدة من حملاتي. وريني حملاتي لختار، وبعدها عدّدي الإعلانات الأول — ما بتتفعّل إلا بعد ما أوافق.',
  },
  {
    id: 'bulk_creative_swap', category: 'bulk_ops', status: 'coming_soon', blockedBy: ['write_path', 'creative_tools'],
    titleEn: 'Bulk Creative Swap', titleAr: 'تبديل تصاميم جماعي',
    descEn: "Swap the creative across a whole ad set — nothing changes until you confirm", descAr: 'تبديل التصميم لكل إعلانات مجموعة وحدة — ما بيتغيّر إشي إلا بعد تأكيدك',
    promptEn: 'Replace the creative on all ads in one ad set with a new creative. Show me my ad sets and creatives so I can choose, preview every change, and swap only after I confirm.',
    promptAr: 'بدّلي التصميم لكل الإعلانات بمجموعة إعلانية وحدة بتصميم جديد. وريني المجموعات والتصاميم لختار، اعرضي كل تغيير قبل، وبدّلي بس بعد ما أوافق.',
  },

  // ── TRENDS (4) ────────────────────────────────────────────────────────────
  {
    id: 'weekly_trend', category: 'trends', status: 'active', blockedBy: [],
    titleEn: 'Weekly Trend Analysis', titleAr: 'اتجاه ١٤ يوم',
    descEn: "Day-by-day performance over the last 14 days, with patterns", descAr: 'الأداء يوم بيوم لآخر ١٤ يوم، مع الأنماط',
    promptEn: 'Show me day-by-day performance for the last 14 days: spend, impressions, conversations started, and cost per conversation. Point out any pattern or unusual day.',
    promptAr: 'وريني الأداء يوم بيوم لآخر 14 يوم: الصرف، الظهور، المحادثات، وتكلفة المحادثة. حدّديلي أي نمط أو يوم غريب.',
  },
  {
    id: 'day_of_week', category: 'trends', status: 'active', blockedBy: [],
    titleEn: 'Day of Week Analysis', titleAr: 'أفضل أيام الأسبوع',
    descEn: "Which days of the week give you the best results", descAr: 'أي أيام بالأسبوع بتعطيك أفضل نتائج',
    promptEn: 'Which days of the week work best for me? Break the last four weeks down by day and compare CTR and cost per conversation. Should I shift budget toward certain days?',
    promptAr: 'أي أيام بالأسبوع الأفضل إلي؟ فصّلي آخر أربع أسابيع حسب اليوم وقارني الـCTR وتكلفة المحادثة. لازم أحوّل ميزانية لأيام معيّنة؟',
  },
  {
    id: 'time_of_day', category: 'trends', status: 'active', blockedBy: [],
    titleEn: 'Time of Day Performance', titleAr: 'أفضل ساعات اليوم',
    descEn: "Which hours of the day bring your best conversations", descAr: 'أي ساعات باليوم بتجيب أفضل محادثات',
    promptEn: 'Analyze performance by hour of day over the last 30 days at the account level. When do I get the best conversations and cost per conversation, and when should I ease off?',
    promptAr: 'حلّلي الأداء حسب ساعة اليوم لآخر 30 يوم على مستوى الحساب. إيمتى بيجيني أفضل محادثات وأفضل تكلفة محادثة، وإيمتى الأفضل أخفّف؟',
  },
  {
    id: 'month_over_month', category: 'trends', status: 'active', blockedBy: [],
    titleEn: 'Month-over-Month Comparison', titleAr: 'شهر مقابل شهر',
    descEn: "This month vs last across spend, conversations, cost, and CTR", descAr: 'هالشهر مقابل الشهر الماضي على الصرف والمحادثات والتكلفة ونسبة النقر',
    promptEn: 'Compare this month to last month across the key metrics: spend, impressions, conversations started, cost per conversation, and CTR. What got better and what got worse?',
    promptAr: 'قارني هالشهر مقابل الشهر الماضي على المؤشرات الأساسية: الصرف، الظهور، المحادثات، تكلفة المحادثة، والـCTR. شو تحسّن وشو ساء؟',
  },
];

export const ADS_TIPS: AdsTip[] = [
  {
    id: 'tip_be_specific',
    titleEn: 'Be specific', titleAr: 'كن محدّداً',
    bodyEn: 'Name the campaign, the date range, or the exact metric you care about — the more specific your question, the sharper the answer.',
    bodyAr: 'سمِّ الحملة أو الفترة الزمنية أو المؤشر اللي يهمّك بالضبط — كل ما كان سؤالك أدقّ، كان الجواب أوضح.',
  },
  {
    id: 'tip_ask_followups',
    titleEn: 'Ask follow-ups', titleAr: 'اسأل أسئلة متابعة',
    bodyEn: "After you get an answer, dig deeper — ask 'why' to understand what's driving the numbers.",
    bodyAr: 'بعد ما ييجيك الجواب، غُص أكثر — اسأل "ليش" لتفهم شو وراء الأرقام.',
  },
  {
    id: 'tip_request_actions',
    titleEn: 'Ask what to do', titleAr: 'اسأل شو تعمل',
    bodyEn: "Don't stop at analysis — ask 'what should I do?'. When actions unlock, campaigns are created paused and wait for your explicit activation.",
    bodyAr: 'ما توقف عند التحليل — اسأل "شو الأفضل أعمل؟". لَمّا تنفتح الإجراءات، الحملات بتتنشأ متوقّفة وبتنتظر تفعيلك الصريح.',
  },
];

/**
 * Resolve the user message for one chat turn.
 *  - promptId given → look it up: unknown → 400; coming_soon → 400
 *    PROMPT_NOT_AVAILABLE; active → the prompt text in the requested locale.
 *  - else → the free-text message.
 * The request schema guarantees EXACTLY ONE of message / promptId is present, so
 * a clicked prompt can never silently drop a typed message. Server-side
 * rejection is the SOURCE OF TRUTH — the web lock is cosmetic.
 */
export function resolveUserMessage(body: PostAdsChatRequest): string {
  if (body.promptId) {
    const entry = ADS_PROMPTS.find((p) => p.id === body.promptId);
    if (!entry) throw new BadRequestException(`Unknown promptId: ${body.promptId}`);
    if (entry.status !== 'active') throw new AdsPromptNotAvailableException(entry.id);
    return body.locale === 'en' ? entry.promptEn : entry.promptAr;
  }
  const msg = body.message?.trim();
  if (!msg) throw new BadRequestException('either message or promptId is required');
  return msg;
}
