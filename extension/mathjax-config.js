// Loaded before MathJax. Extension pages cannot run inline scripts, so the config lives here.
window.MathJax = {
  tex: {
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    // Model output is untrusted: no loading extra files, no links or raw HTML/CSS from TeX.
    packages: { "[-]": ["autoload", "require", "html"] },
  },
  svg: { fontCache: "global" },
  options: { enableMenu: false },
  startup: { typeset: false },
};
