/**
 * Clients — the other half of the admin console on Settings.
 *
 * This used to live in the app shell's gear popover, where every signed-in PM
 * could rename or create a client. It moved here because client records are
 * the root of the whole hierarchy: a rename re-labels every portfolio,
 * meeting and document beneath it, and a delete takes all of them with it.
 *
 * As with the Users section, rendering this for admins only is presentation.
 * The endpoints behind it are admin-gated, so the section being hidden is
 * never what stops a non-admin.
 */
import { useState } from "react";
import AdminSection, { RowMessage } from "./AdminSection";
import NewClientDialog from "./NewClientDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import { deleteClient, updateClient } from "@/lib/api";
import type { Client } from "@/lib/types";

interface Draft {
  name: string;
  email_domain: string;
}

export default function AdminClientsCard() {
  const { clients, refreshClients, selectedClientId, setSelectedClientId } =
    useApp();
  const confirm = useConfirm();

  /** Only clients the admin has actually touched get a draft; everything
   *  else renders straight from the shared client list. */
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [showNew, setShowNew] = useState(false);

  function draftFor(c: Client): Draft {
    return drafts[c.id] ?? { name: c.name, email_domain: c.email_domain ?? "" };
  }

  function edit(c: Client, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [c.id]: { ...draftFor(c), ...patch } }));
  }

  function isDirty(c: Client): boolean {
    const d = drafts[c.id];
    if (!d) return false;
    return (
      d.name.trim() !== c.name ||
      d.email_domain.trim() !== (c.email_domain ?? "")
    );
  }

  async function run(clientId: number, fn: () => Promise<unknown>) {
    setBusyId(clientId);
    setRowErrors((e) => {
      const { [clientId]: _drop, ...rest } = e;
      return rest;
    });
    try {
      await fn();
    } catch (e: any) {
      setRowErrors((prev) => ({
        ...prev,
        [clientId]: e?.message || "The server rejected that change.",
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function save(c: Client) {
    const d = draftFor(c);
    const name = d.name.trim();
    if (!name) {
      setRowErrors((prev) => ({ ...prev, [c.id]: "Name is required." }));
      return;
    }
    await run(c.id, async () => {
      await updateClient(c.id, { name, email_domain: d.email_domain.trim() });
      await refreshClients();
      // Drop the draft so the row falls back to the refreshed server values —
      // otherwise a rejected-then-fixed edit could keep showing stale text.
      setDrafts((prev) => {
        const { [c.id]: _saved, ...rest } = prev;
        return rest;
      });
    });
  }

  async function remove(c: Client) {
    const ok = await confirm({
      title: `Delete ${c.name}?`,
      body: `This deletes the client and everything beneath it — every portfolio, meeting, action item, pre-meeting agenda, proposal and change order. It cannot be undone. Rename the client instead if you only want it out of the way.`,
      confirmLabel: "Delete client",
      destructive: true,
    });
    if (!ok) return;
    await run(c.id, async () => {
      await deleteClient(c.id);
      // The header still points at this client; clear the selection first so
      // the context row and portfolio dropdown don't sit on a dead id.
      if (selectedClientId === c.id) setSelectedClientId(null);
      await refreshClients();
    });
  }

  return (
    <AdminSection
      title="Clients"
      hint={`${clients.length} on file`}
      actions={
        <button
          type="button"
          className="btn-ghost h-[30px] py-0 text-xs"
          onClick={() => setShowNew(true)}
        >
          + New client
        </button>
      }
    >
      {clients.length === 0 ? (
        <p className="px-5 py-4 text-sm text-brand-gray">
          No clients yet. Create one to start building portfolios under it.
        </p>
      ) : (
        <ul className="divide-y divide-surface-hairline">
          {clients.map((c) => {
            const d = draftFor(c);
            const busy = busyId === c.id;
            const dirty = isDirty(c);
            const error = rowErrors[c.id];
            return (
              <li key={c.id} className="px-5 py-3">
                <div className="flex flex-wrap items-end gap-2.5">
                  <label className="min-w-[12rem] flex-1">
                    <span className="label">Client name</span>
                    <input
                      type="text"
                      className="input"
                      value={d.name}
                      disabled={busy}
                      onChange={(e) => edit(c, { name: e.target.value })}
                    />
                  </label>
                  <label className="min-w-[10rem] flex-1">
                    <span className="label">Email domain</span>
                    <input
                      type="text"
                      className="input"
                      placeholder="acme.com"
                      value={d.email_domain}
                      disabled={busy}
                      onChange={(e) =>
                        edit(c, { email_domain: e.target.value })
                      }
                    />
                  </label>
                  <div className="flex items-center gap-2 pb-px">
                    <button
                      type="button"
                      className="btn-primary h-[38px] py-0 text-xs"
                      onClick={() => void save(c)}
                      disabled={busy || !dirty}
                      title={
                        dirty ? "Save changes" : "No changes to save"
                      }
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn-danger h-[38px] py-0 text-xs"
                      onClick={() => void remove(c)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {error && (
                  <div className="mt-2 max-w-[34rem]">
                    <RowMessage>{error}</RowMessage>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="border-t border-surface-hairline px-5 py-3 text-xs text-brand-lightgray">
        The email domain auto-matches meeting attendees to this client.
        Deleting a client cascades through every portfolio beneath it.
      </p>

      <NewClientDialog open={showNew} onClose={() => setShowNew(false)} />
    </AdminSection>
  );
}
