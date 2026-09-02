/**
 * "Who closes this action" — the one control that decides whether an action
 * reaches the client portal.
 *
 * THREE VALUES, NOT A CHECKBOX. `null` means nobody has triaged the action,
 * `false` means it is ours, `true` means it is the client's. A checkbox would
 * collapse the first two, and they are different answers: "we looked and it is
 * ours" is a decision, "nobody looked" is a to-do. Only `true` puts the row on
 * the client's screen, so the untriaged default is the safe one — a PM has to
 * say so before anything leaves the building.
 *
 * WHY IT CANNOT BE DERIVED. `owner` is free text ("CK, KC", "Vendor TBD") and
 * a null `owner_user_id` covers every owner without a PMO 360 login — vendors,
 * utilities and the client alike. Inferring from either would put a
 * subcontractor's name on a client-facing list, which is exactly the leak the
 * portal's allowlists exist to prevent. So it is an explicit flag.
 *
 * ONE COMPONENT for the meeting editor and the rolling-actions page: they set
 * the same field with the same rules, and the rule worth not drifting on is
 * what each value means.
 */
import clsx from "clsx";

export type OwedBy = boolean | null | undefined;

/** Shown wherever the control is explained rather than merely rendered. */
export const OWED_BY_HINT =
  "Client actions appear in the client portal's “waiting on you” list once the minutes are sent.";

export default function OwedBySelect({
  value,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: OwedBy;
  onChange: (next: boolean | null) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const v = value == null ? "" : value ? "client" : "us";
  return (
    <select
      className={clsx(
        className ?? "select select-sm w-full",
        // The client state is the one with consequences outside this building,
        // so it is the only one that carries a tint. Blue, not red: it is a
        // fact about the row, not a warning.
        value === true && "border-brand-blue text-brand-deepblue font-semibold",
      )}
      value={v}
      disabled={disabled}
      aria-label={ariaLabel ?? "Who closes this action"}
      title={OWED_BY_HINT}
      onChange={(e) =>
        onChange(e.target.value === "" ? null : e.target.value === "client")
      }
    >
      {/* First, and what every existing action already is. */}
      <option value="">Owed by —</option>
      <option value="us">Owed by us</option>
      <option value="client">Owed by client</option>
    </select>
  );
}
