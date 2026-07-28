/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
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
        // Castillo brand palette. Keep these in sync with backend
        // config.BrandColors — the values are also exposed at /api/settings.
        brand: {
          red: "#ad1f2b",
          darkred: "#991f2b",
          black: "#333132",
          gray: "#4d4d4f",
          lightgray: "#bcbec0",
          nearwhite: "#e6e7e8",
          brown: "#5e4b40",
          brightred: "#e12a3f",
          blue: "#1aa6c9",
          green: "#278747",
          brightgreen: "#4ab751",
          gold: "#c7bb2e",
          // Readable text-weight variants — the base gold and blue are too
          // light to sit on white at body sizes.
          deepgold: "#8a8021",
          deepblue: "#0e6b85",
        },
        // Warm neutral surfaces derived from the brand near-black. These
        // replace Tailwind's slate scale app-wide: slate reads cool/blue
        // beside Castillo red, these sit with it.
        surface: {
          page: "#f5f4f3",      // app background
          card: "#ffffff",
          border: "#e6e7e8",    // card + control borders (= brand.nearwhite)
          hairline: "#f0efee",  // dividers inside cards
          rowhover: "#faf9f9",  // row hover + table headers
          ghost: "#d8d6d5",     // ghost-button border
          mute: "#eceae9",      // disabled / inactive fills
        },
        status: {
          open: {
            bg: "#fce8ea",
            text: "#791f1f",
            border: "#ad1f2b",
          },
          pending: {
            bg: "#fdeac0",
            text: "#5e3f00",
            border: "#c7bb2e",
          },
          completed: {
            bg: "#c7e9a3",
            text: "#1a3a04",
            border: "#278747",
          },
          cancelled: {
            bg: "#e6e7e8",
            text: "#1a1a1a",
            border: "#888780",
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
        card: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)",
        // Document page (Preview/Send paper) and timeline bars.
        page: "0 6px 18px rgba(51,49,50,0.08)",
        bar: "0 1px 2px rgba(51,49,50,0.15)",
      },
    },
  },
  plugins: [],
};
