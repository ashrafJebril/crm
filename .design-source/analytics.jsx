// src/screens/analytics.jsx — analytics dashboard

function ScreenAnalytics({ t }) {
  const isAr = t.lang === "ar";
  const tx = (en, ar) => isAr ? ar : en;

  // Synthetic 7d × 24h heatmap of message volume
  const heatData = useMemo(() => {
    const out = [];
    for (let d = 0; d < 7; d++) {
      const row = [];
      for (let h = 0; h < 24; h++) {
        // peak around lunch + early evening, weekday vs weekend variance
        const peakA = Math.exp(-Math.pow((h - 13) / 4, 2)) * (d < 5 ? 1.2 : 0.9);
        const peakB = Math.exp(-Math.pow((h - 19) / 3, 2)) * (d < 5 ? 0.9 : 1.3);
        row.push(Math.round((peakA + peakB) * 80 + Math.random() * 12));
      }
      out.push(row);
    }
    return out;
  }, []);

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Analytics","التحليلات")}
        subtitle={tx("How your AI and team performed across all channels","أداء الذكاء والفريق")}
        actions={<>
          <button className="btn"><IconCal w={13} />Last 30 days<IconChevDown w={12} /></button>
          <button className="btn"><IconBook w={13} />{tx("Export","تصدير")}</button>
          <button className="btn primary"><IconPlus w={13} />{tx("New report","تقرير جديد")}</button>
        </>}
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
        {/* Top stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <BigStat label={tx("Conversations","محادثات")} value="8,432" delta="+12.4%" spark={[180,220,210,240,270,260,310]} />
          <BigStat label={tx("AI handled","حل بالذكاء")} value="86%" delta="+4.1pp" spark={DAILY.ai_pct.map(v=>v*100)} />
          <BigStat label={tx("CSAT","تقييم")} value="91" unit="/100" delta="+2" spark={DAILY.csat} />
          <BigStat label={tx("Avg response","الرد")} value="19" unit="s" delta="-23s" invert spark={DAILY.responseTime.slice().reverse()} />
          <BigStat label={tx("Revenue attributed","إيرادات منسوبة")} value="SAR 412k" delta="+18.2%" spark={[120,148,162,178,201,228,242]} />
        </div>

        {/* Volume + AI vs Human breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <h3>{tx("Conversation volume","حجم المحادثات")}</h3>
                <div className="sub">{tx("Last 30 days · grouped by week","آخر ٣٠ يوم")}</div>
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 11, fontFamily: "var(--font-mono)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--accent)", opacity: 0.7 }} /> AI
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--ink-3)" }} /> Human
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--bad)" }} /> Escalated
                </span>
              </div>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <StackedBars />
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Resolution mix","نوع الحل")}</h3>
              <span className="sub">{tx("By outcome","حسب النتيجة")}</span>
            </div>
            <div style={{ padding: 18, display: "flex", alignItems: "center", gap: 18 }}>
              <div style={{ position: "relative" }}>
                <Donut size={150} thickness={20} items={[
                  { value: 68, color: "var(--accent)" },
                  { value: 18, color: "var(--info)" },
                  { value: 9, color: "var(--warn)" },
                  { value: 5, color: "var(--bad)" },
                ]} />
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
                  <div>
                    <div className="display" style={{ fontSize: 28, color: "var(--ink)" }}>86%</div>
                    <div style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>AI auto-resolved</div>
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, display: "grid", gap: 10 }}>
                {[
                  { l: tx("AI resolved","حل ذاتي"), c: "var(--accent)", v: "68%", n: "5,734" },
                  { l: tx("AI + human assist","ذكاء + بشري"), c: "var(--info)", v: "18%", n: "1,517" },
                  { l: tx("Escalated to human","تصعيد"), c: "var(--warn)", v: "9%", n: "759" },
                  { l: tx("Unresolved","لم يحل"), c: "var(--bad)", v: "5%", n: "421" },
                ].map(it => (
                  <div key={it.l} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 10, height: 10, background: it.c, borderRadius: 2 }} />
                    <span style={{ flex: 1, fontSize: 13 }}>{it.l}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{it.n}</span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, width: 44, textAlign: "end" }}>{it.v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Heatmap + agents leaderboard */}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <h3>{tx("When are customers messaging?","متى يراسلك العملاء؟")}</h3>
              <span className="sub">Asia/Riyadh</span>
            </div>
            <div style={{ padding: "12px 18px 8px", overflowX: "auto" }}>
              <Heatmap data={heatData} cell={20} w={580} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                <span>less</span>
                {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
                  <span key={v} style={{ width: 14, height: 14, background: `oklch(0.78 0.18 150 / ${v})`, borderRadius: 3 }} />
                ))}
                <span>more</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Agent leaderboard","ترتيب الوكلاء")}</h3>
              <span className="sub">{tx("by resolved","حسب الحلول")}</span>
            </div>
            <div style={{ padding: "8px 6px" }}>
              {[...AGENTS, ...TEAM.slice(2,4).map(t => ({ ...t, isHuman: true }))]
                .map(p => ({
                  ...p,
                  resolved: p.isHuman ? Math.floor(40 + Math.random() * 60) : p.convs,
                  csat: p.isHuman ? 88 + Math.floor(Math.random() * 8) : p.csat,
                }))
                .sort((a, b) => b.resolved - a.resolved)
                .map((p, i) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                                          borderRadius: 6 }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", width: 16 }}>#{i+1}</span>
                    {p.isHuman
                      ? <Avatar name={p.name} color={p.color} size="sm" />
                      : <Avatar agent={p} ai size="sm" />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                        {p.name}
                        {p.isHuman ? <Badge kind="human">human</Badge> : <Badge kind="ai">AI</Badge>}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>CSAT {p.csat || "—"}</div>
                    </div>
                    <div style={{ width: 80 }}>
                      <Spark values={[8, 14, 12, 18, 20, 22, p.resolved/10]} w={80} h={20} />
                    </div>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, width: 44, textAlign: "end" }}>{p.resolved}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>

        {/* Funnel + intents */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h"><h3>{tx("Lead → Customer funnel","قمع التحويل")}</h3></div>
            <div style={{ padding: 18, display: "grid", gap: 6 }}>
              {[
                { l: tx("Conversations started","بدأ المحادثة"), v: 8432, w: 1.0 },
                { l: tx("Replied to AI","ردّ على الذكاء"), v: 7821, w: 0.93 },
                { l: tx("Qualified","تأهّل"), v: 4218, w: 0.50 },
                { l: tx("Booked / proposal","حجز/عرض"), v: 1847, w: 0.22 },
                { l: tx("Converted","تحوّل"), v: 1142, w: 0.135 },
              ].map((it, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "180px 1fr 80px", alignItems: "center", gap: 12, padding: "4px 0" }}>
                  <span style={{ fontSize: 13 }}>{it.l}</span>
                  <div style={{ height: 22, background: "var(--bg-2)", borderRadius: 4, position: "relative", overflow: "hidden" }}>
                    <div style={{ width: `${it.w * 100}%`, height: "100%", background: "var(--accent)", opacity: 0.3 + i * 0.15 }} />
                    <span className="mono" style={{ position: "absolute", insetInlineStart: 8, top: 3, fontSize: 11, color: "var(--ink-1)" }}>{Math.round(it.w * 100)}%</span>
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)", textAlign: "end" }}>{it.v.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Top intents","أهم النوايا")}</h3>
              <span className="sub">{tx("auto-classified","مصنّفة")}</span>
            </div>
            <div style={{ padding: 18 }}>
              {INTENTS.map((it, i) => (
                <div key={it.name} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px 60px", alignItems: "center", gap: 12, padding: "8px 0" }}>
                  <span style={{ fontSize: 13 }}>{it.name}</span>
                  <div style={{ height: 5, background: "var(--bg-2)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${it.pct * 3}%`, height: "100%", background: "var(--accent)", opacity: 0.4 + i * 0.08 }} />
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>{it.count}</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 500, textAlign: "end" }}>{it.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BigStat({ label, value, unit, delta, sub, spark, invert }) {
  const isDown = delta && delta.startsWith("-");
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24 }}>{value}{unit && <span className="unit">{unit}</span>}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className={`delta ${isDown ? (invert ? "" : "down") : ""}`}>
          {isDown ? <IconArrowDown w={11} /> : <IconArrowUp w={11} />}{delta}
        </span>
        {spark && <Spark values={spark} w={64} h={20} />}
      </div>
    </div>
  );
}

function StackedBars() {
  const weeks = [
    { ai: 1240, hum: 420, esc: 92 },
    { ai: 1410, hum: 396, esc: 84 },
    { ai: 1612, hum: 411, esc: 78 },
    { ai: 1842, hum: 432, esc: 71 },
  ];
  const max = Math.max(...weeks.map(w => w.ai + w.hum + w.esc));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 24, height: 200 }}>
      {weeks.map((w, i) => {
        const total = w.ai + w.hum + w.esc;
        const h = (total / max) * 180;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>{total.toLocaleString()}</span>
            <div style={{ width: "100%", maxWidth: 70, height: h, display: "flex", flexDirection: "column", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ flex: w.esc, background: "var(--bad)", opacity: 0.6 }} />
              <div style={{ flex: w.hum, background: "var(--ink-3)" }} />
              <div style={{ flex: w.ai, background: "var(--accent)", opacity: 0.7 }} />
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>W{i+1}</span>
          </div>
        );
      })}
    </div>
  );
}

window.ScreenAnalytics = ScreenAnalytics;
