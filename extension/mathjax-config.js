// Loaded before MathJax. Extension pages cannot run inline scripts, so the config lives here.
window.MathJax = {
  tex: {
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    // Model output is untrusted: no loading extra files, no links or raw HTML/CSS from TeX.
    // mhchem (\ce, \pu) is on by default; physics is bundled but off, so ask for it by name.
    packages: { "[-]": ["autoload", "require", "html"], "[+]": ["physics"] },
    // The physics package takes \div for divergence. Students write it for division far more often,
    // so put it back; \divergence still names the operator.
    macros: { div: "\\mathbin{\\unicode{0x00F7}}" },
  },
  svg: { fontCache: "global" },
  options: { enableMenu: false },
  startup: { typeset: false },
};
