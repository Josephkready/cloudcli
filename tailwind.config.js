/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Tests quote class names in order to assert on them — motionScale.test.ts
    // has to name the utilities it forbids. Scanning them would emit the very
    // CSS the guard exists to keep out of the bundle.
    "!./src/**/*.{test,spec}.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['"Encode Sans"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        serif: ['Merriweather', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
        'mobile-nav': 'var(--mobile-nav-total)',
      },
      // The semantic motion scale (#271). Intent lives in the class name, the
      // value lives here — tune timing in one place instead of across ~90 call
      // sites. Values must stay literal: Tailwind scans raw source text, so a
      // computed `duration-${n}` would never be generated.
      //
      // `DEFAULT` is what a bare `transition-*` utility bakes in (Tailwind's
      // own default is 150ms), so the ~140 `transition-colors` sites that never
      // named a duration land on `fast` too.
      transitionDuration: {
        DEFAULT: '120ms',
        instant: '75ms', // press feedback: active:scale, tap highlight
        fast: '120ms',   // hover, focus ring, row highlight
        base: '160ms',   // small transforms, disclosure, toggles, progress
        slow: '220ms',   // overlays, drawers, sheets, panel collapse
      },
      keyframes: {
        // The travel has to be a whole number of gradient tiles, or the loop
        // snaps. `background-position` percentages resolve against
        // (element width − background width), not element width — and
        // Shimmer.tsx sizes the tile at 250%, so that factor is −1.5W. A span
        // of N percentage points therefore slides the gradient 1.5 × N/100 × W,
        // against a tile that repeats every 2.5W.
        //
        // The old 200% → -200% pair spanned 400 points = 6W = 2.4 tiles, so
        // every iteration ended 0.4 of a tile (a full element width) out of
        // phase and jumped — a visible hitch every 2s. 250% → -250% spans 500
        // points = 7.5W = exactly 3 tiles, which is phase-continuous.
        //
        // Coupled to the 250% in Shimmer.tsx: change one and this breaks.
        // Retune the feel with the `animation` duration below, never here.
        shimmer: {
          '0%': { backgroundPosition: '250% 0' },
          '100%': { backgroundPosition: '-250% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-content-show': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
      },
      animation: {
        // 2.5s, not 2s: the keyframes above now cover 7.5W instead of 6W, so
        // the extra 25% of duration keeps the sweep at the same 3W/s it has
        // always moved at. Perceived speed is unchanged — only the loop point.
        shimmer: 'shimmer 2.5s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 150ms ease-out',
        'dialog-content-show': 'dialog-content-show 150ms ease-out',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}