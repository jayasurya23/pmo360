/**
 * LoginPage — the branded sign-in gate. Shown by <AuthGate> whenever MSAL is
 * configured and the visitor is not signed in, so the app can't be used
 * anonymously. Castillo red washing down a solar-field background into the app
 * surface, PMO 360 logo, and a "Sign in with Microsoft" button.
 *
 * It also has to answer the other question this URL gets asked. A client who
 * was given the hostname rather than a full link lands HERE, on a Microsoft
 * button they cannot use and no indication that a door for them exists — so
 * there is a quiet second line pointing at /portal. Nothing is disclosed by
 * it: the portal page is credential-gated and every failure there is one
 * identical 401, so the existence of a client sign-in was never the secret.
 */
import { useState } from "react";
import { useAuth } from "@/auth/useAuth";
import pmoLogo from "@/assets/brand/pmo360_logo.png";
import castilloWhite from "@/assets/brand/castillo_white.png";

/**
 * Castillo red washing down over a faint aerial solar-panel texture, recreated
 * with layered CSS gradients so it scales cleanly to any viewport.
 *
 * This screen renders before the app shell, but the pre-paint script in
 * index.html has already put `.dark` on <html> by then, so it themes like
 * everything else. Every colour is read through its token variable rather
 * than baked, which means:
 *   - the red stays. It's the brand moment, and it carries white text
 *     identically on both themes; `--brand-red` is the fill step, tuned for
 *     exactly that.
 *   - what the red fades INTO follows the app background — white in light,
 *     near-black in dark — instead of dumping a full-screen white slab under
 *     a dark-mode user at 7am.
 * The panel texture is the one thing left neutral: those layers are
 * multiply-blended shading, not colour, so plain black shadow lines are the
 * physically-honest thing to draw on either base.
 */
const BG: React.CSSProperties = {
  backgroundColor: "rgb(var(--surface-page))",
  backgroundImage: [
    // red wash: solid at top, thinning through the middle, page colour at base
    "linear-gradient(157deg, rgb(var(--brand-red)) 0%, rgb(var(--brand-red) / 0.96) 20%, rgb(var(--brand-red) / 0.55) 42%, rgb(var(--brand-red) / 0.18) 62%, rgb(var(--surface-page) / 0.72) 82%, rgb(var(--surface-page)) 100%)",
    // panel rows — thin diagonal lines at the aerial angle
    "repeating-linear-gradient(123deg, rgba(0,0,0,0.16) 0 1.5px, transparent 1.5px 15px)",
    // cross seams between panel blocks
    "repeating-linear-gradient(33deg, rgba(0,0,0,0.10) 0 1.5px, transparent 1.5px 92px)",
    // soft base tint under the panels
    "linear-gradient(157deg, rgb(var(--surface-ghost)) 0%, rgb(var(--surface-mute)) 70%, rgb(var(--surface-page)) 100%)",
  ].join(", "),
  backgroundBlendMode: "normal, multiply, multiply, normal",
};

/** Microsoft's four-square mark. These hexes are Microsoft's own brand colours
 *  and are fixed by their identity guidelines — they are not ours to theme,
 *  and they sit on a solid red button that looks the same either way. */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export default function LoginPage({ busy = false }: { busy?: boolean }) {
  const { signIn } = useAuth();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const working = busy || pending;

  async function go() {
    setErr(null);
    setPending(true);
    try {
      await signIn(); // full-page redirect to Microsoft
    } catch (e: any) {
      setErr(e?.message || "Sign-in is unavailable right now.");
      setPending(false);
    }
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden" style={BG}>
      {/* Castillo wordmark, top-left. Always the white knockout — it sits on
          the solid red band at the top of the gradient in both themes, so it
          needs no variant. */}
      <img
        src={castilloWhite}
        alt="Castillo Engineering"
        className="absolute left-7 top-7 h-12 w-auto select-none sm:left-10 sm:top-9 sm:h-[54px]"
        draggable={false}
      />

      {/* Sign-in card. `surface-card` is white in light — pixel-identical to
          what this was — and the raised near-black in dark, so the card reads
          as a lifted panel on the red field either way. */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-16">
        <div className="w-full max-w-[430px] rounded-2xl border border-surface-border bg-surface-card/[0.96] p-9 text-center shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm sm:p-11">
          {/* Same knockout treatment as the header: "PMO" is black artwork
              with no white variant, so it would disappear on the dark card. */}
          <img
            src={pmoLogo}
            alt="PMO 360"
            className="mx-auto h-14 w-auto select-none dark:brightness-0 dark:invert sm:h-[60px]"
            draggable={false}
          />
          <p className="mt-4 text-sm text-brand-gray">
            Castillo Engineering project-management workspace
          </p>

          <button
            type="button"
            onClick={go}
            disabled={working}
            className="mt-8 inline-flex w-full items-center justify-center gap-3 rounded-[9px] bg-brand-red py-[13px] text-sm font-semibold text-white transition hover:bg-brand-darkred focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-brand-red/40 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <MicrosoftMark />
            {working ? "Signing you in…" : "Sign in with Microsoft"}
          </button>

          {err && <p className="mt-4 text-xs text-brand-brightred">{err}</p>}

          <p className="mt-7 text-[11px] leading-relaxed text-brand-lightgray">
            Sign in with your Castillo Microsoft 365 account. Access is restricted
            to authorized Castillo Engineering staff.
          </p>

          {/* A PLAIN ANCHOR, never a router <Link>. main.tsx decides which of
              the two apps to mount ONCE, from window.location.pathname at
              startup; a client-side navigation would change the URL with the
              internal bundle still mounted and PortalApp never booted. The
              full page load is the mechanism, not an oversight. */}
          <div className="mt-7 border-t border-surface-hairline pt-5">
            <p className="text-[11px] text-brand-lightgray">
              Not Castillo staff?{" "}
              <a
                href="/portal"
                className="font-semibold text-brand-red underline-offset-2 hover:underline"
              >
                Go to the client portal
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* footer */}
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 text-center">
        <span className="text-[11px] text-brand-lightgray">
          © Castillo Engineering · PMO 360
        </span>
      </div>
    </div>
  );
}
