/** @type {import('tailwindcss').Config} */

// Every colour resolves through a CSS variable holding space-separated RGB
// channels, so `.dark` on <html> can redefine the whole palette in one place
// and the entire app follows — no `dark:` variant on thousands of classes.
// The channel form (not hex) is what keeps Tailwind's opacity modifiers
// working, e.g. `bg-brand-black/40`. Values live in styles/index.css.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Opt in to class-based dark mode. `media` would follow the OS and ignore
  // the in-app toggle, which is the control PMs actually reach for.
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // Falls back to Helvetica when Jost isn't loaded (matches the
        // Castillo brand style guide).
        sans: ["Jost", "Helvetica", "system-ui", "sans-serif"],
        // Castillo uses Jost EVERYWHERE — there is no monospace in the brand.
        // Mapping `mono` to Jost too means every `font-mono` utility and the
        // elements Tailwind Preflight defaults to monospace (code/kbd/pre/samp)
        // render in Jost as well. Keep in sync with `sans`.
        mono: ["Jost", "Helvetica", "system-ui", "sans-serif"],
      },
      colors: {
        // Castillo brand palette. Light values stay in sync with backend
        // config.BrandColors — those are also what the PDFs and Excel use, and
        // documents have no dark mode, so the light values are the canonical
        // ones. Dark overrides are a screen-only concern.
        brand: {
          red: token("brand-red"),
          darkred: token("brand-darkred"),
          black: token("brand-black"),
          gray: token("brand-gray"),
          lightgray: token("brand-lightgray"),
          nearwhite: token("brand-nearwhite"),
          brown: token("brand-brown"),
          brightred: token("brand-brightred"),
          blue: token("brand-blue"),
          green: token("brand-green"),
          brightgreen: token("brand-brightgreen"),
          gold: token("brand-gold"),
          // Readable text-weight variants — base gold and blue are too light
          // to sit on white. In dark they invert: they become the *lighter*
          // step, since the surface is now the dark one.
          deepgold: token("brand-deepgold"),
          deepblue: token("brand-deepblue"),
        },
        // Warm neutral surfaces derived from the brand near-black. These
        // replace Tailwind's slate scale app-wide: slate reads cool/blue
        // beside Castillo red, these sit with it.
        surface: {
          page: token("surface-page"),
          card: token("surface-card"),
          border: token("surface-border"),
          hairline: token("surface-hairline"),
          rowhover: token("surface-rowhover"),
          ghost: token("surface-ghost"),
          mute: token("surface-mute"),
          // Always-white paper. A rendered PDF page is a document, not a UI
          // surface — it stays white in both themes.
          paper: token("surface-paper"),
        },
        status: {
          open: {
            bg: token("status-open-bg"),
            text: token("status-open-text"),
            border: token("status-open-border"),
          },
          pending: {
            bg: token("status-pending-bg"),
            text: token("status-pending-text"),
            border: token("status-pending-border"),
          },
          completed: {
            bg: token("status-completed-bg"),
            text: token("status-completed-text"),
            border: token("status-completed-border"),
          },
          cancelled: {
            bg: token("status-cancelled-bg"),
            text: token("status-cancelled-text"),
            border: token("status-cancelled-border"),
          },
        },
      },
      maxWidth: {
        // Content widths from the redesign: wide boards vs document-like pages.
        shell: "1560px",
        doc: "1240px",
        narrow: "860px",
      },
      boxShadow: {
        // Shadows are variables too — the light theme's soft grey shadows
        // vanish on a dark background, so dark uses deeper, larger ones.
        card: "var(--shadow-card)",
        page: "var(--shadow-page)",
        bar: "var(--shadow-bar)",
      },
    },
  },
  plugins: [],
};
