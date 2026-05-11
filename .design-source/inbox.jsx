// src/screens/inbox.jsx — three-pane WhatsApp inbox with AI co-pilot

function ScreenInbox({ t, setTweak }) {
  const isAr = t.lang === "ar";
  const tx = (en, ar) => isAr ? ar : en;
  const [filter, setFilter] = useState("all");
  const [activeId, setActiveId] = useState("k1");

  const filtered = useMemo(() => {
    if (filter === "all") return CONVERSATIONS;
    if (filter === "ai") return CONVERSATIONS.filter(c => c.status === "ai");
    if (filter === "human") return CONVERSATIONS.filter(c => c.status === "human");
    if (filter === "closed") return CONVERSATIONS.filter(c => c.status === "closed");
    if (filter === "spam") return CONVERSATIONS.filter(c => c.status === "spam");
    if (filter === "unread") return CONVERSATIONS.filter(c => c.unread > 0);
    return CONVERSATIONS;
  }, [filter]);

  const active = CONVERSATIONS.find(c => c.id === activeId) || CONVERSATIONS[0];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr 340px", flex: 1, minHeight: 0 }}>
      <InboxList filter={filter} setFilter={setFilter} convs={filtered} activeId={activeId} setActiveId={setActiveId} tx={tx} />
      <ConversationPane conv={active} tx={tx} t={t} />
      <ContactRightRail conv={active} tx={tx} />
    </div>
  );
}

function InboxList({ filter, setFilter, convs, activeId, setActiveId, tx }) {
  const filters = [
    { id: "all", label: tx("All","الكل"), count: CONVERSATIONS.length },
    { id: "ai", label: tx("AI handled","ذكاء"), count: CONVERSATIONS.filter(c=>c.status==="ai").length, kind: "ai" },
    { id: "human", label: tx("Assigned","معيّنة"), count: CONVERSATIONS.filter(c=>c.status==="human").length, kind: "human" },
    { id: "unread", label: tx("Unread","غير مقروءة"), count: CONVERSATIONS.filter(c=>c.unread>0).length },
    { id: "closed", label: tx("Closed","مغلقة"), count: CONVERSATIONS.filter(c=>c.status==="closed").length },
    { id: "spam", label: tx("Spam","مزعجة"), count: CONVERSATIONS.filter(c=>c.status==="spam").length },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", borderInlineEnd: "1px solid var(--line-soft)", minHeight: 0 }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{tx("Inbox","الرسائل")}</h2>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn ghost icon sm" title={tx("Filter","فلتر")}><IconFilter w={14} /></button>
            <button className="btn ghost icon sm" title={tx("Sort","ترتيب")}><IconMore w={14} /></button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {filters.map(f => (
            <button key={f.id}
                    className={`chip ${filter === f.id ? "active" : ""}`}
                    onClick={() => setFilter(f.id)}>
              {f.label}<span className="ct">{f.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {convs.map(c => {
          const contact = CONTACTS.find(x => x.id === c.contactId);
          const agent = AGENTS.find(a => a.id === c.agent);
          return (
            <div key={c.id}
                 className={`conv-row ${activeId === c.id ? "active" : ""}`}
                 onClick={() => setActiveId(c.id)}>
              <Avatar name={contact?.name} color="200" size="lg" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: c.unread ? 600 : 500, fontSize: 13, flex: 1, minWidth: 0, textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" }}>
                    {contact?.name}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: c.unread ? "var(--accent)" : "var(--ink-3)" }}>{c.lastAt}</span>
                </div>
                <div style={{
                  fontSize: 12,
                  color: c.unread ? "var(--ink-1)" : "var(--ink-3)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  marginTop: 2,
                }}>
                  {c.lastFrom === "ai" && <span style={{ color: "var(--accent)" }}>↳ </span>}
                  {c.lastFrom === "human" && <span style={{ color: "var(--human)" }}>↳ </span>}
                  {c.preview}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                  {c.status === "ai" && agent && <Badge kind="ai" dot>{agent.name}</Badge>}
                  {c.status === "human" && <Badge kind="human" dot>Human</Badge>}
                  {c.status === "closed" && <Badge kind="ok" dot>closed</Badge>}
                  {c.status === "spam" && <Badge kind="bad" dot>spam</Badge>}
                  {c.escalated && <Badge kind="warn" dot>escalated</Badge>}
                  {c.unread > 0 && <span style={{ marginInlineStart: "auto", fontFamily: "var(--font-mono)", fontSize: 10, background: "var(--accent)", color: "var(--accent-ink)", padding: "1px 6px", borderRadius: 999 }}>{c.unread}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <style>{`
        .chip { display: inline-flex; align-items: center; gap: 5px;
          padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line-soft);
          background: transparent; color: var(--ink-2); font-size: 11px;
          font-family: var(--font-mono); cursor: pointer; }
        .chip:hover { color: var(--ink); border-color: var(--line); }
        .chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-ring); }
        .chip .ct { color: var(--ink-3); font-size: 10px; }
        .chip.active .ct { color: var(--accent); }

        .conv-row { display: flex; gap: 10px; padding: 12px 14px;
          border-bottom: 1px solid var(--line-soft); cursor: pointer; }
        .conv-row:hover { background: var(--bg-1); }
        .conv-row.active { background: var(--bg-2); border-inline-start: 2px solid var(--accent); padding-inline-start: 12px; }
      `}</style>
    </div>
  );
}

function ConversationPane({ conv, tx, t }) {
  if (!conv) return null;
  const contact = CONTACTS.find(c => c.id === conv.contactId);
  const agent = AGENTS.find(a => a.id === conv.agent);
  const messages = conv.messages || [
    { from: "them", t: "10:42", body: conv.preview },
    { from: "ai",   t: "10:43", body: tx("On it — let me check the latest for you.","حسنًا، دعيني أتحقق."), agent: conv.agent },
    { from: "them", t: "10:44", body: tx("Thanks!","شكراً!") },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg)" }}>
      {/* header */}
      <div style={{ height: 56, padding: "0 18px", borderBottom: "1px solid var(--line-soft)",
                    display: "flex", alignItems: "center", gap: 12 }}>
        <Avatar name={contact?.name} color="200" size="lg" />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{contact?.name}</span>
            <Badge kind="ok" dot>online</Badge>
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 6, fontFamily: "var(--font-mono)" }}>
            <span>{contact?.phone}</span><span>·</span><span>{contact?.industry}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {agent && (
            <div style={{ display: "flex", alignItems: "center", gap: 6,
                          padding: "4px 10px 4px 4px", border: "1px solid var(--accent-ring)",
                          background: "var(--accent-soft)", borderRadius: 999 }}>
              <Avatar agent={agent} ai size="sm" />
              <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>
                {agent.name} {tx("is replying","يردّ")}
              </span>
            </div>
          )}
          <button className="btn"><IconHand w={14} />{tx("Take over","تولّى")}</button>
          <button className="btn ghost icon"><IconMore w={16} /></button>
        </div>
      </div>

      {/* AI status banner */}
      {conv.status === "ai" && agent && (
        <div style={{ padding: "8px 18px", display: "flex", gap: 12, alignItems: "center",
                      borderBottom: "1px solid var(--line-soft)", fontSize: 12, color: "var(--ink-2)",
                      background: "var(--bg-1)" }}>
          <IconSparkles w={14} stroke={1.5} />
          <span><strong style={{ color: "var(--accent)" }}>{agent.name}</strong> {tx("is handling this conversation","تتولى هذه المحادثة")}.</span>
          <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {tx("intent","نية")}: <span style={{ color: "var(--ink-1)" }}>{conv.intent}</span>
          </span>
          <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {tx("confidence","ثقة")}: <span style={{ color: "var(--ok)" }}>{Math.round((conv.confidence || 0.9) * 100)}%</span>
          </span>
          <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
            <button className="btn sm ghost"><IconPause w={11} />{tx("Pause AI","إيقاف الذكاء")}</button>
          </span>
        </div>
      )}

      {/* messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 12,
                    backgroundImage: "radial-gradient(circle, var(--line-soft) 1px, transparent 1px)",
                    backgroundSize: "24px 24px", backgroundPosition: "0 0" }}>
        <div className="day-divider"><span>{tx("Today","اليوم")}</span></div>
        {messages.map((m, i) => <Bubble key={i} m={m} agent={agent} tx={tx} />)}
      </div>

      {/* AI suggestion above composer */}
      {conv.suggested && (
        <div style={{ padding: "10px 18px", borderTop: "1px solid var(--line-soft)",
                      background: "var(--bg-1)", display: "flex", gap: 12, alignItems: "flex-start" }}>
          <IconSparkles w={14} />
          <div style={{ flex: 1, fontSize: 13 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.06 }}>
              {tx("AI suggestion","اقتراح ذكي")}
            </div>
            <div style={{ color: "var(--ink-1)" }}>{conv.suggested}</div>
          </div>
          <button className="btn sm primary"><IconCheck w={11} />{tx("Use","استخدم")}</button>
          <button className="btn sm ghost">{tx("Edit","تعديل")}</button>
        </div>
      )}

      {/* composer */}
      <div style={{ padding: 14, borderTop: "1px solid var(--line-soft)" }}>
        <div style={{ border: "1px solid var(--line)", borderRadius: 12, background: "var(--bg-1)", padding: 10 }}>
          <textarea placeholder={tx("Reply as Yara — or let Luna handle it","ردّي بنفسك أو دعي Luna ترد")}
                    style={{ width: "100%", minHeight: 60, resize: "none", border: 0, outline: 0, background: "transparent", color: "inherit", fontSize: 14, fontFamily: "inherit" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <button className="btn ghost icon sm"><IconAttach w={14} /></button>
            <button className="btn ghost icon sm"><IconTemplate w={14} /></button>
            <button className="btn ghost sm"><IconSparkles w={12} />{tx("Improve","حسّن")}</button>
            <span className="muted mono" style={{ fontSize: 11, marginInlineStart: "auto" }}>
              {tx("Replying as","يرد بصفة")}: <strong style={{ color: "var(--ink-1)" }}>Yara</strong>
            </span>
            <button className="btn primary"><IconSend w={13} />{tx("Send","إرسال")}</button>
          </div>
        </div>
      </div>

      <style>{`
        .day-divider { display: flex; align-items: center; gap: 12px; margin: 4px 0; }
        .day-divider::before, .day-divider::after { content: ""; flex: 1; height: 1px; background: var(--line-soft); }
        .day-divider span { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); padding: 2px 10px;
          border: 1px solid var(--line-soft); border-radius: 999px; background: var(--bg-elev); }
      `}</style>
    </div>
  );
}

function Bubble({ m, agent, tx }) {
  const isOut = m.from === "ai" || m.from === "human";
  const isAI = m.from === "ai";
  return (
    <div style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", gap: 8 }}>
      {!isOut && <div style={{ width: 24 }} />}
      <div style={{ maxWidth: "62%" }}>
        {isOut && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, justifyContent: "flex-end" }}>
            {isAI ? (
              <>
                <Avatar agent={agent} ai size="sm" />
                <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500 }}>{agent?.name}</span>
                <Badge kind="ai">AI</Badge>
              </>
            ) : (
              <>
                <Avatar name="Yara" color="150" size="sm" />
                <span style={{ fontSize: 11, fontWeight: 500 }}>Yara</span>
                <Badge kind="human">Human</Badge>
              </>
            )}
          </div>
        )}
        <div style={{
          padding: "8px 12px",
          borderRadius: isOut ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
          background: isOut ? "var(--bubble-out)" : "var(--bubble-in)",
          border: `1px solid ${isOut ? "var(--bubble-out-line)" : "var(--bubble-in-line)"}`,
          color: "var(--ink)",
          fontSize: 13.5,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}>
          {m.body}
          {m.attach && (
            <div style={{ marginTop: 6, padding: "8px 10px", border: "1px dashed var(--line)", borderRadius: 8,
                         display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <IconBook w={12} />{m.attach}
            </div>
          )}
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 3, textAlign: isOut ? "end" : "start" }}>
          {m.t} {isOut && "✓✓"}
        </div>
      </div>
    </div>
  );
}

function ContactRightRail({ conv, tx }) {
  if (!conv) return null;
  const contact = CONTACTS.find(c => c.id === conv.contactId);
  const agent = AGENTS.find(a => a.id === conv.agent);

  return (
    <aside style={{ borderInlineStart: "1px solid var(--line-soft)", background: "var(--bg-1)",
                    overflowY: "auto", display: "flex", flexDirection: "column", padding: 18, gap: 18 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 8 }}>
        <Avatar name={contact?.name} color="200" size="xl" />
        <div style={{ fontSize: 16, fontWeight: 600 }}>{contact?.name}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)" }}>{contact?.phone}</div>
        <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
          {contact?.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button className="btn"><IconPhone w={13} />{tx("Call","اتصال")}</button>
        <button className="btn"><IconBook w={13} />{tx("Notes","ملاحظات")}</button>
      </div>

      <div>
        <SectionLabel>{tx("Lifecycle","المرحلة")}</SectionLabel>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
          {[tx("Lead","عميل محتمل"), tx("Qualified","مؤهل"), tx("Customer","عميل"), tx("Repeat","متكرر")].map((s, i) => (
            <div key={i} style={{ flex: 1, textAlign: "center" }}>
              <div style={{ height: 4, background: i <= 2 ? "var(--accent)" : "var(--bg-2)", marginInline: 1, opacity: i <= 2 ? 0.4 + i * 0.2 : 1 }} />
              <div style={{ fontSize: 10, marginTop: 6, color: i === 2 ? "var(--accent)" : "var(--ink-3)", fontWeight: i === 2 ? 600 : 400 }}>{s}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>{tx("AI assignment","الوكيل المخصص")}</SectionLabel>
        {agent && (
          <div style={{ marginTop: 8, padding: 10, borderRadius: 10, border: "1px solid var(--line-soft)",
                       display: "flex", gap: 10, alignItems: "center" }}>
            <Avatar agent={agent} ai size="lg" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{agent.name}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{agent.role}</div>
            </div>
            <button className="btn ghost sm"><IconChevDown w={12} /></button>
          </div>
        )}
      </div>

      <div>
        <SectionLabel>{tx("Recent activity","نشاط حديث")}</SectionLabel>
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            [tx("Replied to viewing offer","ردت على عرض المعاينة"), "2m"],
            [tx("Opened floor plan PDF","فتحت ملف المخطط"), "10m"],
            [tx("Tagged VIP","وُضع وسم VIP"), "yesterday"],
            [tx("First conversation","المحادثة الأولى"), "Mar 18"],
          ].map(([line, when], i) => (
            <li key={i} style={{ display: "flex", gap: 8, fontSize: 12 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", marginTop: 6, flex: "0 0 auto", opacity: 1 - i * 0.2 }} />
              <div style={{ flex: 1, color: "var(--ink-1)" }}>{line}</div>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{when}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <SectionLabel>{tx("Internal notes","ملاحظات داخلية")}</SectionLabel>
        <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line-soft)", fontSize: 12, color: "var(--ink-1)" }}>
          {tx("Reem signed last year — wants similar layout but bigger kitchen. Prefers Saturday viewings.", "ريم وقعت العام الماضي، تفضل نفس التصميم بمطبخ أكبر. تفضل المعاينة يوم السبت.")}
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>— Yara · 2d ago</div>
        </div>
      </div>
    </aside>
  );
}

const SectionLabel = ({ children }) => (
  <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase",
                letterSpacing: 0.08, color: "var(--ink-3)" }}>{children}</div>
);

window.ScreenInbox = ScreenInbox;
