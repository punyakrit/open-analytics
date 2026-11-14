/** @type {import('tailwindcss').Config} */
import plugin from 'tailwindcss/plugin';

/*
 * Two themes from one set of names. Every colour the components use is a CSS variable, set here for the
 * light theme on :root and for the dark theme under [data-theme="dark"] (public/theme.js picks one before
 * the page draws, from the saved choice or the system setting). `stone-50…800` always run from the
 * quietest fill to the strongest text, so a class like `text-stone-500` means "secondary text" in both.
 *
 * Data colours: cobalt for visitors, marigold for revenue, green for people online right now.
 */
const LIGHT = {
  paper: '#f4f5f7', // page
  surface: '#ffffff', // panels, inputs, menus
  ink: '#15171c', // main text
  visitors: '#3f5ce6',
  revenue: '#e09422',
  visitorsSoft: '#e7ebfd',
  revenueSoft: '#fcefd8',
  live: '#0f9f74',
  'stone-50': '#f5f6f8',
  'stone-100': '#eceef2',
  'stone-200': '#e1e4ea',
  'stone-300': '#cdd2da',
  'stone-400': '#99a0ad',
  'stone-500': '#687080',
  'stone-600': '#4a5160',
  'stone-700': '#353b47',
  'stone-800': '#22262f',
  'stone-900': '#171a20',
  'stone-950': '#0c0e12',
  'amber-50': '#fffbeb',
  'amber-100': '#fef3c7',
  'amber-200': '#fde68a',
  'amber-700': '#b45309',
  'amber-800': '#92400e',
  'amber-900': '#78350f',
  'emerald-50': '#ecfdf5',
  'emerald-100': '#d1fae5',
  'emerald-200': '#a7f3d0',
  'emerald-600': '#059669',
  'emerald-800': '#065f46',
  'emerald-900': '#064e3b',
  'green-50': '#f0fdf4',
  'green-100': '#dcfce7',
  'red-50': '#fef2f2',
  'red-100': '#fee2e2',
  'red-200': '#fecaca',
  'red-500': '#ef4444',
  'red-600': '#dc2626',
  'violet-50': '#f5f3ff',
  'violet-200': '#ddd6fe',
  'violet-700': '#6d28d9',
  'sky-50': '#f0f9ff',
};

const DARK = {
  paper: '#0f1115',
  surface: '#171a20',
  ink: '#e8eaee',
  visitors: '#8b9cff',
  revenue: '#f2b44e',
  visitorsSoft: '#1f2645',
  revenueSoft: '#3a2c15',
  live: '#3ed6a5',
  'stone-50': '#1d2028',
  'stone-100': '#232731',
  'stone-200': '#2c313c',
  'stone-300': '#3b414d',
  'stone-400': '#6f7786',
  'stone-500': '#9199a7',
  'stone-600': '#b1b8c3',
  'stone-700': '#cdd2da',
  'stone-800': '#e1e5eb',
  'stone-900': '#0b0d11',
  'stone-950': '#07080b',
  'amber-50': '#2a2210',
  'amber-100': '#3a2e12',
  'amber-200': '#5a4614',
  'amber-700': '#fbbf24',
  'amber-800': '#fcd34d',
  'amber-900': '#fde68a',
  'emerald-50': '#0f281f',
  'emerald-100': '#123527',
  'emerald-200': '#1d4d39',
  'emerald-600': '#34d399',
  'emerald-800': '#6ee7b7',
  'emerald-900': '#a7f3d0',
  'green-50': '#0f2818',
  'green-100': '#123520',
  'red-50': '#2c1414',
  'red-100': '#3b1717',
  'red-200': '#5c2424',
  'red-500': '#f87171',
  'red-600': '#f87171',
  'violet-50': '#1f1830',
  'violet-200': '#4c3b7a',
  'violet-700': '#c4b5fd',
  'sky-50': '#0f2230',
};

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
const vars = (palette) => Object.fromEntries(Object.entries(palette).map(([k, v]) => [`--${k}`, channels(v)]));
const color = (name) => `rgb(var(--${name}) / <alpha-value>)`;

// { stone: { 50: 'rgb(var(--stone-50) / …)', … }, ink: '…', … }
const colors = {};
for (const name of Object.keys(LIGHT)) {
  const [family, shade] = name.split('-');
  if (shade) (colors[family] ??= {})[shade] = color(name);
  else colors[family] = color(name);
}

export default {
  content: ['./src/dashboard/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors,
      boxShadow: {
        card: '0 1px 0 rgb(var(--stone-200) / 0.6)',
        pop: '0 12px 40px -12px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(var(--stone-200))',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': { ...vars(LIGHT), colorScheme: 'light' },
        // No saved choice yet and the script didn't run: follow the system.
        '@media (prefers-color-scheme: dark)': { ':root:not([data-theme="light"])': { ...vars(DARK), colorScheme: 'dark' } },
        ':root[data-theme="dark"]': { ...vars(DARK), colorScheme: 'dark' },
      });
    }),
  ],
};
