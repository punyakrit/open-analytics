// The Open Analytics tracker (public/js/script.js), when a page loads it. Always call it with optional chaining.
interface Window {
  openAnalytics?: ((cmd: 'goal' | 'identify' | 'pageview', a?: any, b?: any) => void) & {
    q?: unknown[];
    attribution?: () => { ml_visitor_id?: string; ml_session_id?: string };
  };
}
