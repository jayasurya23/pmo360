import clsx from "clsx";
import type { Attendee, GlobalAttendee } from "@/lib/types";

interface SelectedAttendee {
  full_name: string;
  initials: string;
  organization: string;
}

interface Props {
  available: (Attendee | GlobalAttendee)[];
  selected: SelectedAttendee[];
  onToggle: (a: SelectedAttendee) => void;
}

export default function AttendeeChips({ available, selected, onToggle }: Props) {
  const selectedSet = new Set(selected.map((s) => s.full_name));

  // Group by organization for nicer scanning
  const byOrg = available.reduce<Record<string, (Attendee | GlobalAttendee)[]>>(
    (acc, a) => {
      const key = a.organization || "Other";
      (acc[key] = acc[key] || []).push(a);
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-4">
      {Object.entries(byOrg).map(([org, people]) => (
        <div key={org}>
          <div className="text-xs font-semibold uppercase tracking-wide text-brand-gray mb-2">
            {org}
          </div>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => {
              const active = selectedSet.has(p.full_name);
              return (
                <button
                  type="button"
                  key={`${org}-${p.id}`}
                  onClick={() =>
                    onToggle({
                      full_name: p.full_name,
                      initials: p.initials,
                      organization: p.organization || "",
                    })
                  }
                  className={clsx(
                    "px-3 py-1.5 rounded-full text-xs border transition",
                    active
                      ? "bg-brand-red text-white border-brand-red"
                      : "bg-surface-card text-brand-black border-brand-lightgray hover:border-brand-red"
                  )}
                >
                  <span className="mr-1">{active ? "✓" : "+"}</span>
                  {p.full_name}{" "}
                  <span className="opacity-70">({p.initials})</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
