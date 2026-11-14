// Runs before the page draws (a plain, blocking script in <head>) so the saved theme is in place on the
// first frame instead of flashing the other one. It is a file rather than inline code so the page's
// Content-Security-Policy can allow scripts from this site only ("script-src 'self'").
(function () {
  var theme;
  try {
    theme = localStorage.getItem('oa_theme');
  } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
