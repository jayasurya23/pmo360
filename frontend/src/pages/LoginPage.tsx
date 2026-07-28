/**
 * LoginPage — the branded sign-in gate. Shown by <AuthGate> whenever MSAL is
 * configured and the visitor is not signed in, so the app can't be used
 * anonymously. Castillo red → white solar-field background, PMO 360 logo, and a
 * single "Sign in with Microsoft" button.
 */
import { useState } from "react";
import { useAuth } from "@/auth/useAuth";
import pmoLogo from "@/assets/brand/pmo360_logo.png";
import castilloWhite from "@/assets/brand/castillo_white.png";

// Castillo red fading over a faint aerial solar-panel texture, fading to white —
// recreated with layered CSS gradients so it scales cleanly to any viewport.
const BG: React.CSSProperties = {
  backgroundColor: "#f4f5f7",
  backgroundImage: [
    // red wash: solid at top, transparent through the middle, white at the base
    "linear-gradient(157deg, #a01a27 0%, rgba(168,26,40,0.96) 20%, rgba(178,42,55,0.55) 42%, rgba(226,178,183,0.18) 62%, rgba(255,255,255,0.72) 82%, #ffffff 100%)",
    // panel rows — thin diagonal lines at the aerial angle
    "repeating-linear-gradient(123deg, rgba(15,23,42,0.16) 0 1.5px, transparent 1.5px 15px)",
    // cross seams between panel blocks
    "repeating-linear-gradient(33deg, rgba(15,23,42,0.10) 0 1.5px, transparent 1.5px 92px)",
    // soft base tint under the panels
    "linear-gradient(157deg, #cfd6de 0%, #eef1f4 70%, #ffffff 100%)",
  ].join(", "),
  backgroundBlendMode: "normal, multiply, multiply, normal",
};

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
      {/* Castillo wordmark, top-left, on the red field */}
      <img
        src={castilloWhite}
        alt="Castillo Engineering"
        className="absolute left-7 top-7 h-12 w-auto select-none sm:left-10 sm:top-9 sm:h-[54px]"
        draggable={false}
      />

      {/* Sign-in card */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-16">
        <div className="w-full max-w-[430px] rounded-2xl border border-white/60 bg-white/[0.96] p-9 text-center shadow-[0_24px_60px_rgba(51,49,50,0.35)] backdrop-blur-sm sm:p-11">
          <img
            src={pmoLogo}
            alt="PMO 360"
            className="mx-auto h-14 w-auto select-none sm:h-[60px]"
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
