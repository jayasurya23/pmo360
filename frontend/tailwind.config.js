/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Falls back to Helvetica when Jost isn't loaded (matches the
        // Castillo brand style guide).
        sans: ["Jost", "Helvetica", "system-ui", "sans-serif"],
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
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [],
};
