/**
 * Client Contacts — the client-side address book, and the headline card of the
 * Clients tab in Settings.
 *
 * READ-OPEN, WRITE-GATED, the same contract the rest of the app keeps: anybody
 * signed in can look a contact up, and only `client_mgmt` holders see add /
 * edit / delete. Hiding those controls is presentation — every write below
 * lands on an endpoint that refuses the caller on its own.
 *
 * GROUPED BY CLIENT rather than listed alphabetically. Twenty-one clients and
 * potentially hundreds of contacts means the question is nearly always "who do
 * we talk to at X", so the client is the heading instead of a sixth column —
 * which also hands the email column the width a real address needs. Search and
 * the client picker narrow the same grouped list rather than swapping in a
 * second layout.
 *
 * THE IMPORT IS WHY THIS CARD EXISTS RATHER THAN A BUTTON. It walks the meeting
 * attendees already on file and matches each email's domain against the client
 * organisations below. Whatever matches nothing still lands — `client_id` is
 * nullable precisely so it can — and sorts to the TOP under its own heading
 * with an inline client picker beside every row. A count in a toast is not
 * something an admin can act on; a row with a dropdown on it is.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import AdminSection, { RowMessage } from "./AdminSection";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listClientContacts,
  createClientContact,
  updateClientContact,
  deleteClientContact,
  importClientContacts,
} from "@/lib/api";

/**
 * The render shape, structurally compatible with the API's ClientContactOut.
 *
 * Declared here rather than imported so this card depends on the api.ts
 * *functions* and not on a type name — the fields it actually paints are the
 * contract, and anything the server adds later flows through untouched.
 */
interface ContactRow {
  id: number;
  // Nullable to match the server, which returns Optional[str] for all three.
  // A local type that disagrees with the API is not insulation, it is a second
  // place for the contract to be wrong — and because both copies were wrong the
  // same way, tsc saw two lies agree and reported nothing.
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  /** Null when the import found no client whose domain matched. */
  client_id?: number | null;
  title?: string | null;
  domain?: string | null;
}

/** A contact's name for prose — confirms, aria labels, anywhere the two parts
 *  are read as one string. Filtered rather than interpolated because either
 *  half can be null in imported data, and `${first} ${last}` renders the word
 *  "null" to sighted users and reads it aloud to screen readers. */
function fullName(c: ContactRow): string {
  return (
    [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
    c.email ||
    "this contact"
  );
}

type ImportOutcome = Awaited<ReturnType<typeof importClientContacts>>;

/** Sentinel filter values. Real client ids are numbers, so a string key can
 *  never collide with one. */
const ALL = "__all__";
const UNMATCHED = "__unmatched__";

/** Group key for the contacts that matched no client. */
const NO_CLIENT = -1;

export default function ClientContactsCard({
  canManage,
}: {
  /** `client_mgmt` holders and admins — everyone else reads. */
  canManage: boolean;
}) {
  const { clients } = useApp();
  const confirm = useConfirm();

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState<string>(ALL);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const [editing, setEditing] = useState<ContactRow | "new" | null>(null);

  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportOutcome | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await listClientContacts();
      setContacts(rows);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Could not load the contact directory.");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => setLoading(false));
  }, [reload]);

  const clientName = useCallback(
    (id: number | null | undefined) =>
      clients.find((c) => c.id === id)?.name ?? "",
    [clients],
  );

  // ---- Search + client filter, then group ----
  // Terms are ANDed so "sarah acme" narrows the way somebody expects it to,
  // and the client name is part of the haystack so a search alone can stand in
  // for the picker.
  const visible = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return contacts.filter((c) => {
      if (clientFilter === UNMATCHED) {
        if (c.client_id != null) return false;
      } else if (clientFilter !== ALL) {
        if (String(c.client_id ?? "") !== clientFilter) return false;
      }
      if (!terms.length) return true;
      const hay = [
        c.first_name,
        c.last_name,
        c.email,
        c.title ?? "",
        c.domain ?? "",
        clientName(c.client_id),
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [contacts, query, clientFilter, clientName]);

  /** Unmatched first — they are the ones needing a decision — then clients
   *  alphabetically. Empty groups never render. */
  const groups = useMemo(() => {
    const byClient = new Map<number, ContactRow[]>();
    for (const c of visible) {
      const key = c.client_id ?? NO_CLIENT;
      const list = byClient.get(key);
      if (list) list.push(c);
      else byClient.set(key, [c]);
    }
    const out = [...byClient.entries()].map(([id, rows]) => ({
      id,
      name: id === NO_CLIENT ? "Unassigned" : clientName(id) || `Client #${id}`,
      domain: id === NO_CLIENT ? "" : clients.find((c) => c.id === id)?.email_domain ?? "",
      // Coalesce before comparing: 16 of the 118 contacts the live roster
      // imports have no last name at all, and a null here threw inside this
      // useMemo during render. With no ErrorBoundary in the app that unmounted
      // the whole SPA, not just this tab — one import click, white screen.
      rows: rows.sort(
        (a, b) =>
          (a.last_name ?? "").localeCompare(b.last_name ?? "") ||
          (a.first_name ?? "").localeCompare(b.first_name ?? ""),
      ),
    }));
    out.sort((a, b) => {
      if (a.id === NO_CLIENT) return -1;
      if (b.id === NO_CLIENT) return 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [visible, clients, clientName]);

  const unmatchedCount = useMemo(
    () => contacts.filter((c) => c.client_id == null).length,
    [contacts],
  );

  async function run(id: number, fn: () => Promise<unknown>) {
    setBusyId(id);
    setRowErrors((e) => {
      const { [id]: _drop, ...rest } = e;
      return rest;
    });
    try {
      await fn();
    } catch (e: any) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: e?.message || "The server rejected that change.",
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function assignClient(c: ContactRow, nextClientId: number | null) {
    await run(c.id, async () => {
      await updateClientContact(c.id, { client_id: nextClientId });
      await reload();
    });
  }

  async function remove(c: ContactRow) {
    const who = fullName(c);
    const ok = await confirm({
      title: `Remove ${who}?`,
      body: "This only removes them from the contact directory. Meetings they attended, and anything they are named on, are untouched.",
      confirmLabel: "Remove contact",
      destructive: true,
    });
    if (!ok) return;
    await run(c.id, async () => {
      await deleteClientContact(c.id);
      await reload();
    });
  }

  async function runImport() {
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await importClientContacts();
      setImportResult(result);
      await reload();
    } catch (e: any) {
      setImportError(e?.message || "The import could not be run.");
    } finally {
      setImportBusy(false);
    }
  }

  const filtering = query.trim().length > 0 || clientFilter !== ALL;

  return (
    <AdminSection
      title="Client Contacts"
      hint={
        loading
          ? "loading…"
          : // The unassigned count rides the header rather than waiting for the
            // import banner, which is dismissible and gone on the next visit.
            `${countOf(contacts.length, "contact")}${
              unmatchedCount ? ` · ${unmatchedCount} unassigned` : ""
            }`
      }
      actions={
        canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost h-[30px] py-0 text-xs"
              onClick={() => void runImport()}
              disabled={importBusy}
              title="Read every meeting attendee on file and add the ones who aren't here yet, matching each email's domain to a client."
            >
              {importBusy ? "Importing…" : "Import from attendees"}
            </button>
            <button
              type="button"
              className="btn-ghost h-[30px] py-0 text-xs"
              onClick={() => setEditing("new")}
            >
              + New contact
            </button>
          </div>
        ) : null
      }
    >
      {/* ---- Toolbar ---- */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-surface-hairline px-5 py-3">
        <input
          type="search"
          className="input h-[34px] w-full py-0 sm:w-[18rem]"
          placeholder="Search name, email, domain or client"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search contacts"
        />
        <select
          className="select h-[34px] w-auto py-0 text-[13px]"
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Filter by client"
        >
          <option value={ALL}>All clients</option>
          {unmatchedCount > 0 && (
            <option value={UNMATCHED}>
              Unassigned ({unmatchedCount})
            </option>
          )}
          {clients.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
        {filtering && (
          <button
            type="button"
            className="text-xs text-brand-gray underline underline-offset-2 hover:text-brand-red"
            onClick={() => {
              setQuery("");
              setClientFilter(ALL);
            }}
          >
            Clear
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-brand-lightgray">
          {filtering
            ? countOf(visible.length, "match", "matches")
            : "Anyone signed in can look a contact up."}
        </span>
      </div>

      {/* ---- Import outcome ----
          Counts alone would be a dead end, so the unmatched line is a control:
          it jumps the list to exactly the rows that need a client picked. */}
      {importError && (
        <div className="border-b border-surface-hairline px-5 py-3">
          <RowMessage>{importError}</RowMessage>
        </div>
      )}
      {importResult && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-surface-hairline bg-surface-mute px-5 py-2.5 text-[12.5px]">
          <span className="font-semibold text-brand-green">
            ✓ {countOf(importResult.imported, "contact")} imported
          </span>
          <span className="text-brand-gray">
            {countOf(importResult.skipped, "attendee")} skipped — already on file
            or no email
          </span>
          {importResult.unmatched.length > 0 ? (
            <>
              <span className="h-4 w-px bg-surface-border" />
              <span className="text-status-pending-text">
                {countOf(importResult.unmatched.length, "contact")} matched no
                client's email domain
              </span>
              <button
                type="button"
                className="font-semibold text-brand-red underline underline-offset-2"
                onClick={() => {
                  setQuery("");
                  setClientFilter(UNMATCHED);
                }}
              >
                Assign them now
              </button>
            </>
          ) : (
            <span className="text-brand-gray">Every one matched a client.</span>
          )}
          <button
            type="button"
            className="ml-auto text-brand-lightgray hover:text-brand-red"
            aria-label="Dismiss import result"
            onClick={() => setImportResult(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* ---- Directory ---- */}
      {loadError ? (
        <p className="px-5 py-4 text-sm text-status-open-text">{loadError}</p>
      ) : loading ? (
        <p className="px-5 py-4 text-sm text-brand-gray">Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="px-5 py-4 text-sm text-brand-gray">
          No contacts yet.{" "}
          {canManage
            ? "Import pulls them straight from the attendees already on your meetings, matched to a client by email domain."
            : "Somebody with the Client Management permission can import them from your meeting attendees."}
        </p>
      ) : groups.length === 0 ? (
        <p className="px-5 py-4 text-sm text-brand-gray">
          Nothing matches that. Clear the search or pick a different client.
        </p>
      ) : (
        // Nothing scrolls sideways at the width the Clients tab renders at —
        // see the budget below. The wrapper is the escape hatch for a phone.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] table-fixed text-[13px]">
            {/* COLUMN BUDGET. The Settings route is max-w-doc (1240px) less the
                shell's px-9 gutters (72px) less the card's 1px borders =
                1166px of table.

                  First name    9rem    144px
                  Last name     9rem    144px
                  Title        10rem    160px
                  Domain      9.5rem    152px
                  Actions    11.5rem    184px   (write-gated; absent on reads)
                                       -----
                  fixed                 784px
                  email (remainder)     382px

                382px carries a 45-character address at 12.5px without
                truncating, which is what a firstname.lastname@ at a real
                company costs. Reads get the 184px back, so the email column
                grows to 566px when the actions column isn't there. */}
            <colgroup>
              <col style={{ width: "9rem" }} />
              <col style={{ width: "9rem" }} />
              <col style={{ width: "10rem" }} />
              {/* No width: table-fixed hands email whatever the rest leave. */}
              <col />
              <col style={{ width: "9.5rem" }} />
              {canManage && <col style={{ width: "11.5rem" }} />}
            </colgroup>

            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-gray">
                <th scope="col" className="px-5 py-2">
                  First name
                </th>
                <th scope="col" className="px-2 py-2">
                  Last name
                </th>
                <th scope="col" className="px-2 py-2">
                  Title
                </th>
                <th scope="col" className="px-2 py-2">
                  Email
                </th>
                <th scope="col" className="px-2 py-2">
                  Domain
                </th>
                {canManage && (
                  <th scope="col" className="px-5 py-2 text-right">
                    Manage
                  </th>
                )}
              </tr>
            </thead>

            {groups.map((g) => (
              <tbody key={g.id}>
                <tr className="border-t border-surface-border bg-surface-mute">
                  <th
                    scope="rowgroup"
                    colSpan={canManage ? 6 : 5}
                    className="px-5 py-1.5 text-left"
                  >
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={clsx(
                          "text-[12.5px] font-bold",
                          g.id === NO_CLIENT
                            ? "text-status-pending-text"
                            : "text-brand-black",
                        )}
                      >
                        {g.name}
                      </span>
                      <span className="text-[11px] text-brand-lightgray">
                        {countOf(g.rows.length, "contact")}
                      </span>
                      {g.domain && (
                        <span className="text-[11px] text-brand-lightgray">
                          · {g.domain}
                        </span>
                      )}
                      {g.id === NO_CLIENT && (
                        <span className="text-[11px] text-status-pending-text">
                          · their email domain matches no client on file
                          {canManage
                            ? " — pick one per row, or add the domain to the client below"
                            : ""}
                        </span>
                      )}
                    </span>
                  </th>
                </tr>

                {g.rows.map((c) => {
                  const busy = busyId === c.id;
                  const error = rowErrors[c.id];
                  return (
                    <Fragment key={c.id}>
                      <tr
                        className={clsx(
                          "border-t border-surface-page align-middle transition hover:bg-surface-rowhover",
                          busy && "opacity-60",
                        )}
                      >
                        <Td className="px-5 font-semibold text-brand-black">
                          {c.first_name || <Dash />}
                        </Td>
                        <Td className="px-2 font-semibold text-brand-black">
                          {/* Blank rather than an em-dash would read as a
                              rendering fault; the dash says "we know, it is
                              missing" — and 16 imported rows are missing it. */}
                          {c.last_name || <Dash />}
                        </Td>
                        <Td className="px-2 text-brand-gray">
                          {c.title || <Dash />}
                        </Td>
                        <Td className="px-2">
                          {/* 25 of the 118 imported contacts have no address —
                              they came off roster rows that never had one. A
                              mailto:null link looks live and silently opens an
                              empty compose window, so show the same em-dash the
                              other empty cells use. */}
                          {c.email ? (
                            <a
                              href={`mailto:${c.email}`}
                              className="block truncate text-brand-black hover:text-brand-red hover:underline"
                              title={c.email}
                            >
                              {c.email}
                            </a>
                          ) : (
                            <Dash />
                          )}
                        </Td>
                        <Td className="px-2 text-brand-gray">
                          {c.domain || <Dash />}
                        </Td>
                        {canManage && (
                          <Td className="px-5">
                            <div className="flex items-center justify-end gap-1.5">
                              {/* The picker rides the unfiled rows only: it is
                                  the repair for the one state the import can
                                  leave behind. On a filed row the same change
                                  is an ordinary edit, and belongs in the
                                  dialog with the rest of the fields. */}
                              {c.client_id == null && (
                                <select
                                  className="h-[26px] min-w-0 flex-1 rounded-md border border-status-pending-border bg-surface-card px-1.5 text-[11.5px] text-brand-black focus:border-brand-red focus:outline-none"
                                  value=""
                                  disabled={busy}
                                  aria-label={`Assign ${c.email} to a client`}
                                  onChange={(e) =>
                                    e.target.value &&
                                    void assignClient(c, Number(e.target.value))
                                  }
                                >
                                  <option value="">Assign client…</option>
                                  {clients.map((cl) => (
                                    <option key={cl.id} value={cl.id}>
                                      {cl.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <IconBtn
                                label={`Edit ${fullName(c)}`}
                                onClick={() => setEditing(c)}
                                disabled={busy}
                              >
                                ✏️
                              </IconBtn>
                              <IconBtn
                                label={`Remove ${fullName(c)}`}
                                onClick={() => void remove(c)}
                                disabled={busy}
                                danger
                              >
                                🗑️
                              </IconBtn>
                            </div>
                          </Td>
                        )}
                      </tr>
                      {error && (
                        <tr>
                          <td
                            colSpan={canManage ? 6 : 5}
                            className="px-5 pb-2.5"
                          >
                            <div className="max-w-[38rem]">
                              <RowMessage>{error}</RowMessage>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <p className="border-t border-surface-hairline px-5 py-3 text-xs text-brand-lightgray">
        {canManage
          ? "The import never overwrites a contact that is already here. A contact with no client still counts as a contact — it just has nowhere to file itself yet."
          : "Anyone can look a contact up. Adding, editing and removing needs the Client Management permission."}
      </p>

      {editing !== null && (
        <ContactDialog
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </AdminSection>
  );
}

/* ============================================================
   Add / edit
   ============================================================ */

/**
 * One contact, in a modal rather than inline.
 *
 * Six fields is too many to edit in a table row without the row becoming the
 * form, and a directory this size is read far more often than it is written —
 * so the list stays a list and the writing happens somewhere else.
 */
function ContactDialog({
  contact,
  onClose,
  onSaved,
}: {
  /** Null when adding. */
  contact: ContactRow | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { clients } = useApp();
  const [first, setFirst] = useState(contact?.first_name ?? "");
  const [last, setLast] = useState(contact?.last_name ?? "");
  const [title, setTitle] = useState(contact?.title ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [domain, setDomain] = useState(contact?.domain ?? "");
  const [clientId, setClientId] = useState<string>(
    contact?.client_id != null ? String(contact.client_id) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  // The domain is the import's matching key, so it is a real field rather than
  // a derived display — but nobody should have to type it twice. Blank falls
  // back to whatever is after the @.
  const effectiveDomain =
    domain.trim() || email.split("@")[1]?.trim().toLowerCase() || "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!first.trim() || !last.trim() || !email.trim()) {
      setError("First name, last name and email are all required.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      client_id: clientId ? Number(clientId) : null,
      first_name: first.trim(),
      last_name: last.trim(),
      title: title.trim() || null,
      email: email.trim(),
      domain: effectiveDomain || null,
    };
    try {
      if (contact) await updateClientContact(contact.id, payload);
      else await createClientContact(payload);
      await onSaved();
    } catch (err: any) {
      setError(err?.message || "The server rejected that.");
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-dialog-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <form
        onSubmit={submit}
        className="card relative w-full max-w-lg space-y-4 p-5 shadow-xl"
      >
        <h3
          id="contact-dialog-title"
          className="text-base font-semibold text-brand-black"
        >
          {contact ? "Edit contact" : "New contact"}
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">First name</label>
            <input
              className="input"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="label">Last name</label>
            <input
              className="input"
              value={last}
              onChange={(e) => setLast(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label className="label">Email</label>
          <input
            type="email"
            className="input"
            placeholder="sarah.chen@acme.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Client</label>
            <select
              className="select"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">— No client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Domain</label>
            <input
              className="input"
              placeholder={effectiveDomain || "acme.com"}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-brand-lightgray">
              Blank takes it from the email.
            </p>
          </div>
        </div>

        <div>
          <label className="label">Title (optional)</label>
          <input
            className="input"
            placeholder="Director of Development"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {error && <RowMessage>{error}</RowMessage>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Saving…" : contact ? "Save contact" : "Add contact"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/* ============================================================
   Small pieces
   ============================================================ */

function Td({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td className={clsx("truncate py-2 align-middle", className)}>{children}</td>
  );
}

/** Empty optional field. An em dash reads as "nothing here" where a blank cell
 *  reads as a layout bug. */
function Dash() {
  return (
    <span className="text-brand-lightgray" aria-label="not set">
      —
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface-card text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40",
        danger
          ? "hover:border-brand-brightred hover:text-brand-brightred"
          : "hover:border-brand-red hover:text-brand-red",
      )}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

/** "1 contact" / "4 contacts". Plurals get spelled out because "1 contacts" in
 *  a header is the kind of thing an admin reads as a bug in the count. */
function countOf(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}
