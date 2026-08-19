# Contacts: Groups & Tags — Design

**Date:** 2026-08-19
**Status:** Approved (groups-as-audiences on the segment engine; tag catalog with quick-create)
**Context:** Contacts organization requested by the owner: manual customer groups and a managed tag catalog, in an attractive, easy UI. Architecture reuses what exists — the segment engine already supports materialized member lists (`SegmentMember`, built for HJZ sync), and contacts already carry tag names — so groups become manual-membership segments (instantly usable as campaign audiences) and tags gain a catalog entity layered UNDER the existing name-based storage (nothing that matches tags by name breaks).

## Goals

1. **Groups**: create named groups, hand-assign contacts (incl. bulk), see live member counts, manage members — and every group is automatically a campaign audience.
2. **Tags**: a managed catalog (name, color) with usage counts, inline rename that propagates to contacts, delete with impact confirm, and quick-create from any tag picker.
3. **Contacts screen**: three tabs (Contacts | Groups | Tags), bulk-select with an action bar (Add to group / Tag), colored tag chips.

## Non-goals

- Upgrading the Inbox `TagEditor` to catalog colors/suggestions (follow-up; it keeps working as-is since tags remain names on the contact).
- Smart-segment editing changes (rule-based segments only *appear* in the Groups tab, read-only membership).
- Auto-grouping rules, group nesting, tag categories.

## 1. Data model

- **New `Tag` model**: `id, workspaceId, name, color (hue string like Segment.color), createdAt`, `@@unique([workspaceId, name])`, `@@index([workspaceId])`.
- **Groups reuse `Segment`**: `origin: "manual"`, `filter: "{}"`, members as `SegmentMember` rows. No schema change to Segment/SegmentMember.
- **Contact.tags stays** the JSON-string array of tag *names* — the single source of assignment truth. The catalog is metadata over those names.

**Migration** (hand-authored SQL + `migrate deploy`, per repo rule):
1. `CREATE TABLE "Tag" …`
2. Absorb existing tags: insert one catalog row per distinct trimmed tag name found in `Contact.tags` (per workspace), with a deterministic color: `((abs(hashtext(name)) % 12) * 30)::text` (12-step hue wheel). `ON CONFLICT DO NOTHING` for idempotence.

## 2. Backend surface

**Tags** (`/tags`, new module or folded into contacts module — implementer's judgment, follow repo idioms):
- `GET /tags` → `[{id, name, color, usageCount}]` (usageCount computed from Contact.tags matches, workspace-scoped).
- `POST /tags {name, color?}` → creates (409/reuse on duplicate name; auto color from the hue wheel when omitted).
- `PATCH /tags/:id {name?, color?}` — **rename propagates**: every contact whose tags array contains the old name (exact match) gets it rewritten to the new name, in one service-level pass; returns the affected-contact count.
- `DELETE /tags/:id` — removes the catalog row AND strips the name from all contacts' tag arrays; returns affected count. (UI confirms with that count first via usageCount.)
- `POST /tags/assign {contactIds: string[], add: string[], remove?: string[]}` — bulk apply/remove tag names on contacts (names not in the catalog are quick-created). Workspace-scoped contact validation.

**Groups** (extend the existing segments module):
- `POST /segments` accepts `origin: "manual"` (creates with empty filter; name/nameAr/color as today).
- Manual-origin **counting** uses `SegmentMember` count (same as hjz-origin) instead of filter evaluation — verify how hjz counts flow through `GET /segments` and reuse that branch.
- `POST /segments/:id/members {contactIds: string[]}` and `DELETE /segments/:id/members/:contactId` — manual-origin segments only (400 on crm/hjz origins); contacts validated workspace-scoped; idempotent adds.
- `GET /segments/:id/members?search=` → member contact rows (id, name, phone, channel/source) for the member-management view.
- Deleting a manual segment cascades members (existing FK behavior — verify).

**Campaign compatibility**: the audience picker already lists `GET /segments` with counts — manual groups appear automatically once counting is correct. No campaign-side changes.

## 3. Frontend — Contacts screen

Three pill tabs under the PageHeader: **Contacts | Groups | Tags** (Inbox-filter idiom). New components live in `src/screens/contacts/` (existing folder), keeping `Contacts.tsx` from growing.

- **Contacts tab**: today's table plus (a) a leading checkbox column (visible on row hover + when any selection exists; header checkbox = select-all-filtered); (b) a sticky **bulk-action bar** sliding in above the table when selection > 0: "N selected · Add to group ▾ · Tag ▾ · Clear" — group dropdown lists manual groups (+ inline "New group…"), tag dropdown is a multi-pick of catalog chips with a quick-create input; (c) row tag chips colored from the catalog (fallback: current neutral chip for names without catalog rows — shouldn't exist after absorption).
- **Groups tab**: card grid (`repeat(auto-fill, minmax(220px,1fr))`) — color-accented cards: name (localized), big member count (`tabular-nums`), badge `manual`/`smart`. "New group" card opens name+nameAr+color form. Clicking a manual card → member view: search-to-add contact picker, member list with remove buttons, empty-state prompting to add from the Contacts tab. Smart segments' cards open a read-only view (filter summary + count) with a hint that membership is rule-based.
- **Tags tab**: table/chip hybrid — color dot + name (inline-editable), usage count, color swatch popover (12-hue wheel), delete with confirm ("Removes the tag from N contacts"). "New tag" inline row at top.
- Bilingual `tx()` everywhere; RTL-safe (logical properties); empty states written, not blank.

## 4. Error handling

Bulk operations report per-call success atomically (single transaction per request where prisma allows; otherwise all-or-nothing per endpoint). UI: optimistic chip/selection updates with rollback + inline error line (app idiom). Tag rename/delete confirm dialogs use the styled Modal (Media.tsx idiom), never window.confirm.

## 5. Testing

- Backend units: tag rename propagation (rewrites exact names only — "VIP" must not touch "VIPER"; note the JSON-string storage), delete strips + counts, assign quick-creates missing catalog rows, manual-segment member add/remove tenancy (foreign contact/segment 404), manual counting, origin guard (400 adding members to crm-origin).
- Migration: absorb step idempotent; colors deterministic.
- E2E (verify skill): create group → bulk-assign from Contacts tab → count updates → group appears in campaign builder audience picker with the right count; tag create/rename/recolor/delete round-trip visible on row chips; Arabic/RTL pass.

## Open verification items (resolve during implementation, before dependent code)

1. Exact stored format of `Contact.tags` (confirm: JSON string array, e.g. `["VIP","New"]`) — drives the SQL absorb step and rename/delete rewrites.
2. How `GET /segments` computes counts for hjz-origin (member-count branch to reuse for manual).
3. `SegmentMember` FK/cascade behavior on segment delete.
